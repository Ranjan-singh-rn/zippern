'use client'

/**
 * Team tickets — the internal board every department shares.
 *
 * The kanban and its drag-and-drop are unchanged. What is new is dependency:
 * a ticket can be marked **blocked by** another ticket, and while its blocker is
 * still open it cannot be dropped into Done. Both ends show the link — the
 * blocked ticket names what is holding it up, and the blocker names what it is
 * holding up.
 *
 * The number that actually matters is per team: "Tech is blocking 6 tickets, 4
 * of them for other teams." Without that, one team quietly stalls everyone else
 * and nobody can point at it.
 *
 * `blockedBy` is stored on the `techTickets` document alongside the rest of the
 * ticket. It is a plain ticket id, written straight to Firestore — no money and
 * no moderation involved, so nothing here needs the audited API.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/AuthProvider'
import {
  canAccess, getDeptFromRole, getDeptStaff, DEPT_NAMES, DEPT_LABELS, STAFF_ROLES,
  type Dept, type CrmRole, type DeptStaffMember,
} from '@/lib/auth'
import { getTechTickets, createTicket, updateTicket, ticketChangeNeedsReason, type TechTicket } from '@/lib/tech'

/**
 * P1-D: closing and reopening a ticket need a reason the server records in the
 * audit log. Returns null when the person cancels; never an empty string.
 */
function askReason(what: string): string | null {
  for (;;) {
    const r = window.prompt(`A reason is required to ${what}. It is kept in the audit log.`)
    if (r === null) return null
    if (r.trim().length >= 3) return r.trim()
  }
}
import {
  Plus, X, ChevronRight, Loader2, Users, Smartphone, Building, Search,
  Link2, Link2Off, Lock, AlertTriangle, Filter, Clock,
} from 'lucide-react'
import type { Timestamp } from 'firebase/firestore'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'

// ── Model ─────────────────────────────────────────────────────────────────────

/**
 * The stored ticket plus its dependency fields.
 *
 * `TechTicket` in lib/tech.ts does not declare these, and that file is shared —
 * so the extra fields are declared here and read off the same document. They are
 * optional, which is exactly right: every ticket written before this existed has
 * neither, and reads back as "not blocked".
 */
type TeamTicket = TechTicket & {
  blockedBy?: string | null
  blockedReason?: string
  blockedAt?: Timestamp | null
}

type Status = TechTicket['status']
type Priority = TechTicket['priority']
type Category = TechTicket['category']

const STATUSES: { key: Status; label: string; color: string }[] = [
  { key: 'open',        label: 'Open',        color: 'border-blue-500/40 bg-blue-500/5' },
  { key: 'in_progress', label: 'In Progress', color: 'border-yellow-500/40 bg-yellow-500/5' },
  { key: 'review',      label: 'Review',      color: 'border-purple-500/40 bg-purple-500/5' },
  { key: 'done',        label: 'Done',        color: 'border-green-500/40 bg-green-500/5' },
]

const STATUS_ORDER: Status[] = ['open', 'in_progress', 'review', 'done']
const PRIORITIES: Priority[] = ['critical', 'high', 'medium', 'low']
const CATEGORIES: Category[] = ['bug', 'feature', 'content', 'design', 'testing', 'support']

const PRIORITY_STYLE: Record<Priority, string> = {
  critical: 'bg-red-500/20 text-red-300',
  high:     'bg-orange-500/20 text-orange-300',
  medium:   'bg-yellow-500/20 text-yellow-300',
  low:      'bg-zinc-700 text-zinc-400',
}

const CATEGORY_STYLE: Record<Category, string> = {
  bug:     'bg-red-900/40 text-red-300',
  feature: 'bg-blue-900/40 text-blue-300',
  content: 'bg-purple-900/40 text-purple-300',
  design:  'bg-pink-900/40 text-pink-300',
  testing: 'bg-cyan-900/40 text-cyan-300',
  support: 'bg-yellow-900/40 text-yellow-300',
}

const DEPT_STYLE: Record<Dept, string> = {
  app:       'bg-blue-800/60 text-blue-300',
  ops:       'bg-orange-800/60 text-orange-300',
  finance:   'bg-green-800/60 text-green-300',
  tech:      'bg-indigo-800/60 text-indigo-300',
  support:   'bg-yellow-800/60 text-yellow-300',
  marketing: 'bg-rose-800/60 text-rose-300',
}

/** Age target in hours, by priority — same idea as the support board. */
const AGE_TARGET_HOURS: Record<Priority, number> = {
  critical: 24,
  high:     72,
  medium:   168,
  low:      336,
}

const MIN_REASON = 6

// ── Helpers ───────────────────────────────────────────────────────────────────

function msOf(ts: Timestamp | null | undefined): number | null {
  if (!ts) return null
  try { return ts.toMillis() } catch { return null }
}

function formatDate(ts: Timestamp | null | undefined): string {
  const ms = msOf(ts)
  if (ms == null) return '—'
  return new Date(ms).toLocaleDateString('en-IN')
}

interface Age { label: string; overdue: boolean; targetHours: number; known: boolean }

function ageOf(t: TeamTicket): Age {
  const target = AGE_TARGET_HOURS[t.priority] ?? AGE_TARGET_HOURS.medium
  const created = msOf(t.createdAt)
  if (created == null) return { label: 'no date', overdue: false, targetHours: target, known: false }
  const hours = (Date.now() - created) / 3_600_000
  const label =
    hours < 1 ? `${Math.max(0, Math.round(hours * 60))}m`
      : hours < 24 ? `${Math.floor(hours)}h`
        : `${Math.floor(hours / 24)}d`
  return { label, overdue: t.status !== 'done' && hours > target, targetHours: target, known: true }
}

function matchesSearch(t: TeamTicket, term: string): boolean {
  const q = term.trim().toLowerCase()
  if (!q) return true
  return [t.title, t.description, t.id, t.reportedBy, t.assignedToName]
    .some((v) => (v ?? '').toLowerCase().includes(q))
}

/** Would setting `blockerId` on `ticketId` create a cycle? Walk the chain and see. */
function wouldCycle(ticketId: string, blockerId: string, byId: Map<string, TeamTicket>): boolean {
  let cursor: string | null | undefined = blockerId
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === ticketId) return true
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = byId.get(cursor)?.blockedBy ?? null
  }
  return false
}

// ── Dependency state, derived once for the whole board ────────────────────────

type BlockState =
  | { kind: 'none' }
  /** Blocker exists and is not done — this ticket cannot reach Done. */
  | { kind: 'blocked'; blocker: TeamTicket }
  /** Blocker exists and is done — the link is history, not a wall. */
  | { kind: 'cleared'; blocker: TeamTicket }
  /** blockedBy points at a ticket that is not in the board any more. */
  | { kind: 'dangling'; blockerId: string }

interface Deps {
  byId: Map<string, TeamTicket>
  state: (t: TeamTicket) => BlockState
  /** Tickets blocked by this one, still open. */
  blocking: (id: string) => TeamTicket[]
  /** Per team: how many open tickets it is blocking, and how many of those belong to other teams. */
  teamBlocking: Record<Dept, { total: number; forOthers: number }>
}

function buildDeps(tickets: TeamTicket[]): Deps {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const blockingMap = new Map<string, TeamTicket[]>()
  const teamBlocking = Object.fromEntries(
    DEPT_NAMES.map((d) => [d, { total: 0, forOthers: 0 }]),
  ) as Record<Dept, { total: number; forOthers: number }>

  for (const t of tickets) {
    if (!t.blockedBy) continue
    const blocker = byId.get(t.blockedBy)
    if (!blocker || blocker.status === 'done') continue
    // Only count a blocked ticket that is itself still live — a done ticket is
    // not being held up by anything.
    if (t.status === 'done') continue

    const list = blockingMap.get(blocker.id) ?? []
    list.push(t)
    blockingMap.set(blocker.id, list)

    const team = blocker.assignedTeam
    if (teamBlocking[team]) {
      teamBlocking[team].total += 1
      if (t.assignedTeam !== team) teamBlocking[team].forOthers += 1
    }
  }

  return {
    byId,
    state: (t) => {
      if (!t.blockedBy) return { kind: 'none' }
      const blocker = byId.get(t.blockedBy)
      if (!blocker) return { kind: 'dangling', blockerId: t.blockedBy }
      return blocker.status === 'done'
        ? { kind: 'cleared', blocker }
        : { kind: 'blocked', blocker }
    },
    blocking: (id) => blockingMap.get(id) ?? [],
    teamBlocking,
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface NewTicketForm {
  title: string
  description: string
  category: Category
  priority: Priority
  assignedTeam: Dept
  assignedTo: string
}

function makeDefaultForm(dept: Dept | null): NewTicketForm {
  return {
    title: '',
    description: '',
    category: 'bug',
    priority: 'medium',
    assignedTeam: dept ?? 'tech',
    assignedTo: '',
  }
}

interface Filters {
  search: string
  team: Dept | 'all'
  priority: Priority | 'all'
  category: Category | 'all'
  assignee: string // uid | 'unassigned' | 'all'
  blockedOnly: boolean
}

export default function TeamTicketsPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const [tickets, setTickets] = useState<TeamTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState<NewTicketForm>(makeDefaultForm(null))
  const [submitting, setSubmitting] = useState(false)
  const [staffByDept, setStaffByDept] = useState<Record<Dept, DeptStaffMember[]>>(
    { app: [], ops: [], finance: [], tech: [], support: [], marketing: [] },
  )
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverKey, setDragOverKey] = useState<Status | null>(null)
  const [linking, setLinking] = useState<TeamTicket | null>(null)
  const [unlinking, setUnlinking] = useState<TeamTicket | null>(null)

  const role = crmUser?.role as CrmRole | undefined
  const isSA = role === 'superadmin'
  const myDept = role ? getDeptFromRole(role) : null
  const allowed = !!crmUser && canAccess(crmUser, STAFF_ROLES)

  const [filters, setFilters] = useState<Filters>({
    search: '', team: 'all', priority: 'all', category: 'all', assignee: 'all', blockedOnly: false,
  })

  // Dept staff default to their own team; superadmin sees everything.
  useEffect(() => {
    if (myDept && !isSA) setFilters((f) => ({ ...f, team: myDept }))
  }, [myDept, isSA])

  useEffect(() => {
    Promise.all(DEPT_NAMES.map((d) => getDeptStaff(d).then((staff) => [d, staff] as const)))
      .then((entries) => setStaffByDept(Object.fromEntries(entries) as Record<Dept, DeptStaffMember[]>))
      .catch(() => { /* pickers degrade to team-only assignment */ })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const list = await getTechTickets()
      setTickets(list as TeamTicket[])
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load team tickets.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authLoading || !allowed) return
    load()
  }, [authLoading, allowed, load])

  // Dependencies are computed from every ticket, never from the filtered view —
  // a blocker on another team must still block even when it is filtered out.
  const deps = useMemo(() => buildDeps(tickets), [tickets])

  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const t of tickets) {
      if (t.assignedTo) seen.set(t.assignedTo, t.assignedToName || t.assignedTo)
    }
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [tickets])

  const visible = useMemo(() => tickets.filter((t) => {
    if (filters.team !== 'all' && t.assignedTeam !== filters.team) return false
    if (filters.priority !== 'all' && t.priority !== filters.priority) return false
    if (filters.category !== 'all' && t.category !== filters.category) return false
    if (filters.assignee === 'unassigned' && t.assignedTo) return false
    if (filters.assignee !== 'all' && filters.assignee !== 'unassigned' && t.assignedTo !== filters.assignee) return false
    if (filters.blockedOnly && deps.state(t).kind !== 'blocked') return false
    return matchesSearch(t, filters.search)
  }), [tickets, filters, deps])

  const filtersActive =
    filters.priority !== 'all' || filters.category !== 'all' ||
    filters.assignee !== 'all' || filters.blockedOnly || !!filters.search.trim()

  async function handleCreate() {
    if (!form.title.trim() || !crmUser) return
    setSubmitting(true)
    setActionError('')
    try {
      const assignee = staffByDept[form.assignedTeam].find((m) => m.uid === form.assignedTo)
      // P1-D: the server sets the reporter and the assignee's name.
      await createTicket({
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        priority: form.priority,
        assignedTeam: form.assignedTeam,
        assignedTo: assignee?.uid,
      })
      setShowModal(false)
      setForm(makeDefaultForm(myDept))
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not create the ticket.')
    } finally {
      setSubmitting(false)
    }
  }

  /** The one rule the board enforces: a blocked ticket cannot reach Done. */
  function refuseDone(ticket: TeamTicket): string | null {
    const state = deps.state(ticket)
    if (state.kind === 'blocked') {
      return `“${ticket.title}” is blocked by “${state.blocker.title}” (${DEPT_LABELS[state.blocker.assignedTeam] ?? state.blocker.assignedTeam}), which is still ${state.blocker.status.replace('_', ' ')}. Close the blocker first, or clear the dependency.`
    }
    if (state.kind === 'dangling') {
      return `“${ticket.title}” is marked blocked by ticket ${state.blockerId}, which no longer exists. Clear the dependency to move it.`
    }
    return null
  }

  async function moveTo(ticket: TeamTicket, next: Status) {
    if (ticket.status === next) return
    if (next === 'done') {
      const refusal = refuseDone(ticket)
      if (refusal) { setActionError(refusal); return }
    }
    setActionError('')
    const why = ticketChangeNeedsReason(ticket, { status: next })
    const reason = why ? askReason(why) : ''
    if (reason === null) return
    const before = tickets
    setTickets((prev) => prev.map((t) => (t.id === ticket.id ? { ...t, status: next } : t)))
    try {
      await updateTicket(ticket.id, { status: next }, reason)
    } catch (e) {
      setTickets(before)
      setActionError(e instanceof Error ? e.message : 'Could not move the ticket.')
    }
  }

  async function handleReassign(ticket: TeamTicket, uid: string) {
    const assignee = staffByDept[ticket.assignedTeam]?.find((m) => m.uid === uid)
    setActionError('')
    try {
      await updateTicket(ticket.id, { assignedTo: assignee?.uid ?? '' })
      await load()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not reassign the ticket.')
    }
  }

  const byStatus = (status: Status) => visible.filter((t) => t.status === status)

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="team tickets" />

  const blockedCount = tickets.filter((t) => deps.state(t).kind === 'blocked').length
  const teamsBlocking = DEPT_NAMES
    .map((d) => ({ dept: d, ...deps.teamBlocking[d] }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Team Tickets</h1>
          <p className="text-zinc-400 mt-1 text-sm">
            Internal tickets any department can file. A ticket can be blocked by another —
            while its blocker is open it cannot move to Done.
          </p>
        </div>
        <button
          onClick={() => { setForm(makeDefaultForm(myDept)); setShowModal(true) }}
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          <Plus size={16} />
          New Ticket
        </button>
      </div>

      {/* Who is holding whom up */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Lock size={14} className="text-amber-400" />
          <h2 className="text-white text-sm font-semibold">Blocking right now</h2>
          <span className="text-zinc-500 text-xs">
            {blockedCount === 0
              ? 'nothing is blocked'
              : `${blockedCount} ticket${blockedCount === 1 ? '' : 's'} cannot close`}
          </span>
        </div>
        {teamsBlocking.length === 0 ? (
          <p className="text-zinc-600 text-xs">
            No team is currently holding up another team&rsquo;s work.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {teamsBlocking.map(({ dept, total, forOthers }) => (
                <button
                  key={dept}
                  onClick={() => setFilters((f) => ({ ...f, team: dept, blockedOnly: false }))}
                  title={`Show ${DEPT_LABELS[dept]} tickets`}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    forOthers > 0
                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  }`}
                >
                  <span className="font-semibold">{DEPT_LABELS[dept]}</span>
                  {' is blocking '}
                  <span className="font-semibold">{total}</span>
                  {forOthers > 0 && (
                    <span className="text-amber-300"> · {forOthers} for other teams</span>
                  )}
                </button>
              ))}
            </div>
            <p className="text-zinc-600 text-[11px] mt-2">
              Counted from open blockers only. &ldquo;For other teams&rdquo; is the number that matters —
              a team blocking itself is a queue; a team blocking everyone else is a bottleneck.
            </p>
          </>
        )}
      </div>

      {/* Search + filters */}
      <div className="flex flex-col lg:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search title, description, reporter, assignee or ticket id…"
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-pink-500"
          />
          {filters.search && (
            <button
              onClick={() => setFilters((f) => ({ ...f, search: '' }))}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={filters.team}
          onChange={(e) => setFilters((f) => ({ ...f, team: e.target.value as Filters['team'] }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Team: all</option>
          {DEPT_NAMES.map((d) => (
            <option key={d} value={d}>{DEPT_LABELS[d]}</option>
          ))}
        </select>

        <select
          value={filters.priority}
          onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value as Filters['priority'] }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Priority: all</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select
          value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as Filters['category'] }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Category: all</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select
          value={filters.assignee}
          onChange={(e) => setFilters((f) => ({ ...f, assignee: e.target.value }))}
          className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">Assignee: all</option>
          <option value="unassigned">Unassigned</option>
          {assigneeOptions.map(([uid, name]) => (
            <option key={uid} value={uid}>{name}</option>
          ))}
        </select>

        <button
          onClick={() => setFilters((f) => ({ ...f, blockedOnly: !f.blockedOnly }))}
          className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm transition-colors shrink-0 border ${
            filters.blockedOnly
              ? 'bg-amber-500/20 border-amber-500/40 text-amber-200'
              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
          }`}
        >
          <Lock size={14} /> Blocked only
        </button>
      </div>

      {filtersActive && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Filter size={12} />
          Showing {visible.length} of {tickets.length} tickets
          <button
            onClick={() => setFilters((f) => ({
              ...f, search: '', priority: 'all', category: 'all', assignee: 'all', blockedOnly: false,
            }))}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            clear
          </button>
        </div>
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

      {/* Board */}
      {loading ? (
        <Loading label="Loading team tickets…" />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : tickets.length === 0 ? (
        <Empty
          title="No team tickets yet"
          hint="File one with “New Ticket”, or route an app support ticket to a team."
        />
      ) : visible.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint="Try a different search or clear the filters."
        />
      ) : (
        <div className="-mx-4 px-4 overflow-x-auto sm:mx-0 sm:px-0 sm:overflow-visible">
          <div className="flex gap-4 min-w-[960px] sm:min-w-0 sm:grid sm:grid-cols-2 xl:grid-cols-4">
            {STATUSES.map(({ key, label, color }) => {
              const items = byStatus(key)
              return (
                <div
                  key={key}
                  onDragOver={(e) => { e.preventDefault(); setDragOverKey(key) }}
                  onDragLeave={() => setDragOverKey((k) => (k === key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOverKey(null)
                    const ticket = tickets.find((t) => t.id === draggingId)
                    if (ticket) moveTo(ticket, key)
                  }}
                  className={`border rounded-xl p-4 w-72 sm:w-auto shrink-0 transition-colors ${color} ${
                    dragOverKey === key ? 'ring-2 ring-pink-500/60' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-semibold text-white text-sm">{label}</h3>
                    <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">
                      {items.length}
                    </span>
                  </div>
                  <div className="space-y-3 min-h-[120px]">
                    {items.map((ticket) => (
                      <TicketCard
                        key={ticket.id}
                        ticket={ticket}
                        deps={deps}
                        staff={staffByDept[ticket.assignedTeam] ?? []}
                        dragging={draggingId === ticket.id}
                        onDragStart={() => setDraggingId(ticket.id)}
                        onDragEnd={() => { setDraggingId(null); setDragOverKey(null) }}
                        onAdvance={() => {
                          const next = STATUS_ORDER[STATUS_ORDER.indexOf(ticket.status) + 1]
                          if (next) moveTo(ticket, next)
                        }}
                        onReassign={(uid) => handleReassign(ticket, uid)}
                        onLink={() => setLinking(ticket)}
                        onUnlink={() => setUnlinking(ticket)}
                      />
                    ))}
                    {items.length === 0 && (
                      <p className="text-zinc-600 text-xs text-center pt-6">No tickets</p>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* New ticket */}
      {showModal && (
        <NewTicketModal
          form={form}
          setForm={setForm}
          staffByDept={staffByDept}
          submitting={submitting}
          onCancel={() => setShowModal(false)}
          onCreate={handleCreate}
        />
      )}

      {/* Set a blocker */}
      {linking && (
        <BlockerPicker
          ticket={linking}
          tickets={tickets}
          byId={deps.byId}
          onCancel={() => setLinking(null)}
          onConfirm={async (blockerId, reason) => {
            await updateTicket(linking.id, { blockedBy: blockerId }, reason)
            setLinking(null)
            await load()
          }}
        />
      )}

      {/* Clear a blocker */}
      {unlinking && (
        <ReasonModal
          title="Clear this dependency"
          blurb={`“${unlinking.title}” will stop being blocked and can move to Done again. The reason is kept on the ticket.`}
          confirmLabel="Clear dependency"
          placeholder="Blocker turned out to be unrelated / was split into its own ticket…"
          onCancel={() => setUnlinking(null)}
          onConfirm={async (reason) => {
            // The server stores it as `Cleared: <reason>`.
            await updateTicket(unlinking.id, { blockedBy: null }, reason)
            setUnlinking(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────────────

function TicketCard({
  ticket, deps, staff, dragging, onDragStart, onDragEnd, onAdvance, onReassign, onLink, onUnlink,
}: {
  ticket: TeamTicket
  deps: Deps
  staff: DeptStaffMember[]
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onAdvance: () => void
  onReassign: (uid: string) => void
  onLink: () => void
  onUnlink: () => void
}) {
  const isFromApp = ticket.source === 'app' || !!ticket.linkedSupportTicketId
  const state = deps.state(ticket)
  const blocking = deps.blocking(ticket.id)
  const age = ageOf(ticket)
  const next = STATUS_ORDER[STATUS_ORDER.indexOf(ticket.status) + 1]
  const doneBlocked = state.kind === 'blocked' || state.kind === 'dangling'

  return (
    <div
      draggable
      onDragStart={(e) => { onDragStart(); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={onDragEnd}
      className={`bg-zinc-900 border rounded-lg p-3 space-y-2 cursor-grab active:cursor-grabbing transition-opacity ${
        dragging ? 'opacity-40' : 'opacity-100'
      } ${state.kind === 'blocked' ? 'border-amber-500/40' : age.overdue ? 'border-red-500/40' : 'border-zinc-700'}`}
    >
      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
        isFromApp
          ? 'bg-sky-900/50 text-sky-300 border border-sky-700/50'
          : 'bg-violet-900/50 text-violet-300 border border-violet-700/50'
      }`}>
        {isFromApp ? <Smartphone size={10} /> : <Building size={10} />}
        {isFromApp ? 'App Ticket' : 'CRM Ticket'}
      </span>

      <p className="text-white text-sm font-medium leading-snug">{ticket.title}</p>

      <div className="flex flex-wrap gap-1.5">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PRIORITY_STYLE[ticket.priority]}`}>
          {ticket.priority}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_STYLE[ticket.category] ?? 'bg-zinc-700 text-zinc-300'}`}>
          {ticket.category}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DEPT_STYLE[ticket.assignedTeam] ?? 'bg-zinc-700 text-zinc-300'}`}>
          {DEPT_LABELS[ticket.assignedTeam] ?? ticket.assignedTeam}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
            age.overdue ? 'bg-red-500/15 text-red-300' : 'bg-zinc-800 text-zinc-400'
          }`}
          title={
            !age.known
              ? 'No createdAt on this ticket, so its age cannot be measured.'
              : age.overdue
                ? `Open ${age.label} — past the ${age.targetHours}h target for ${ticket.priority}.`
                : `Open ${age.label}. Target for ${ticket.priority} is ${age.targetHours}h.`
          }
        >
          <Clock size={9} /> {age.label}{age.overdue ? ' overdue' : ''}
        </span>
      </div>

      {/* This ticket's own blocker */}
      {state.kind === 'blocked' && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md px-2 py-1.5">
          <p className="text-amber-300 text-[11px] font-semibold flex items-center gap-1">
            <Lock size={10} /> Blocked by {DEPT_LABELS[state.blocker.assignedTeam] ?? state.blocker.assignedTeam}
          </p>
          <p className="text-amber-100/80 text-[11px] leading-snug mt-0.5">
            {state.blocker.title} — {state.blocker.status.replace('_', ' ')}
          </p>
          {ticket.blockedReason && (
            <p className="text-amber-100/60 text-[11px] mt-0.5 italic">{ticket.blockedReason}</p>
          )}
        </div>
      )}
      {state.kind === 'cleared' && (
        <div className="bg-green-500/10 border border-green-500/25 rounded-md px-2 py-1.5">
          <p className="text-green-300 text-[11px] flex items-center gap-1">
            <Link2 size={10} /> Blocker done: {state.blocker.title}
          </p>
        </div>
      )}
      {state.kind === 'dangling' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-md px-2 py-1.5">
          <p className="text-red-300 text-[11px] flex items-center gap-1">
            <AlertTriangle size={10} /> Blocked by ticket {state.blockerId}, which no longer exists
          </p>
          <p className="text-red-200/70 text-[11px] mt-0.5">Clear the dependency to let this move.</p>
        </div>
      )}

      {/* What this ticket is holding up */}
      {blocking.length > 0 && (
        <div className="bg-zinc-800/70 border border-zinc-700 rounded-md px-2 py-1.5">
          <p className="text-zinc-300 text-[11px] font-semibold flex items-center gap-1">
            <Link2 size={10} /> Blocking {blocking.length} ticket{blocking.length === 1 ? '' : 's'}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {blocking.slice(0, 3).map((b) => (
              <li key={b.id} className="text-zinc-500 text-[11px] truncate">
                {DEPT_LABELS[b.assignedTeam] ?? b.assignedTeam}: {b.title}
              </li>
            ))}
            {blocking.length > 3 && (
              <li className="text-zinc-600 text-[11px]">+{blocking.length - 3} more</li>
            )}
          </ul>
        </div>
      )}

      <select
        value={ticket.assignedTo ?? ''}
        onChange={(e) => onReassign(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-zinc-300 text-xs focus:outline-none focus:border-pink-500"
      >
        <option value="">— Unassigned ({DEPT_LABELS[ticket.assignedTeam] ?? ticket.assignedTeam}) —</option>
        {staff.map((m) => (
          <option key={m.uid} value={m.uid}>{m.name}</option>
        ))}
      </select>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="truncate">{ticket.reportedBy}</span>
        <span className="shrink-0">{formatDate(ticket.createdAt)}</span>
      </div>

      <div className="flex gap-1.5">
        {ticket.blockedBy ? (
          <button
            onClick={onUnlink}
            className="flex-1 flex items-center justify-center gap-1 text-xs text-zinc-400 hover:text-green-300 border border-zinc-700 hover:border-green-500/50 rounded-md py-1 transition-colors"
          >
            <Link2Off size={11} /> Clear blocker
          </button>
        ) : (
          <button
            onClick={onLink}
            className="flex-1 flex items-center justify-center gap-1 text-xs text-zinc-400 hover:text-amber-300 border border-zinc-700 hover:border-amber-500/50 rounded-md py-1 transition-colors"
          >
            <Link2 size={11} /> Mark blocked
          </button>
        )}
      </div>

      {next && (
        <button
          onClick={onAdvance}
          disabled={next === 'done' && doneBlocked}
          title={
            next === 'done' && doneBlocked
              ? 'This ticket is blocked — clear the dependency or close the blocker first.'
              : undefined
          }
          className="w-full flex items-center justify-center gap-1 text-xs text-zinc-400 hover:text-pink-400 border border-zinc-700 hover:border-pink-500/50 disabled:text-zinc-700 disabled:border-zinc-800 disabled:hover:text-zinc-700 disabled:cursor-not-allowed rounded-md py-1 transition-colors"
        >
          {next === 'done' && doneBlocked ? <Lock size={11} /> : null}
          Move to {STATUSES.find((s) => s.key === next)?.label}
          {!(next === 'done' && doneBlocked) && <ChevronRight size={12} />}
        </button>
      )}
    </div>
  )
}

// ── Blocker picker ────────────────────────────────────────────────────────────

function BlockerPicker({
  ticket, tickets, byId, onCancel, onConfirm,
}: {
  ticket: TeamTicket
  tickets: TeamTicket[]
  byId: Map<string, TeamTicket>
  onCancel: () => void
  onConfirm: (blockerId: string, reason: string) => Promise<void>
}) {
  const [term, setTerm] = useState('')
  const [picked, setPicked] = useState<string>('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const candidates = useMemo(
    () => tickets
      .filter((t) => t.id !== ticket.id && t.status !== 'done')
      .filter((t) => matchesSearch(t, term))
      .slice(0, 60),
    [tickets, ticket.id, term],
  )

  const cycles = picked ? wouldCycle(ticket.id, picked, byId) : false
  const tooShort = reason.trim().length < MIN_REASON

  async function submit() {
    if (!picked || cycles || tooShort || busy) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(picked, reason.trim())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the dependency.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-2xl p-6 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h2 className="text-white font-semibold">What is blocking this?</h2>
            <p className="text-zinc-400 text-sm mt-1">
              &ldquo;{ticket.title}&rdquo; will not be allowed into Done until the ticket you pick is done.
            </p>
          </div>
          <button onClick={onCancel} disabled={busy} className="text-zinc-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="relative mb-2">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            autoFocus
            placeholder="Search open tickets…"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-9 pr-3 py-2 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-pink-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-lg divide-y divide-zinc-800 min-h-[120px] max-h-64">
          {candidates.length === 0 ? (
            <p className="text-zinc-600 text-sm p-4 text-center">
              No open ticket matches. Only tickets that are not already Done can block something.
            </p>
          ) : (
            candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => setPicked(c.id)}
                className={`w-full text-left px-3 py-2 transition-colors ${
                  picked === c.id ? 'bg-pink-500/15' : 'hover:bg-zinc-800/60'
                }`}
              >
                <p className="text-white text-sm truncate">{c.title}</p>
                <p className="text-zinc-500 text-xs mt-0.5">
                  {DEPT_LABELS[c.assignedTeam] ?? c.assignedTeam} · {c.status.replace('_', ' ')} · {c.priority}
                </p>
              </button>
            ))
          )}
        </div>

        {cycles && (
          <div className="flex items-start gap-2 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">
              That would create a loop — the ticket you picked already depends on this one, directly or
              through a chain. Neither would ever be able to close.
            </p>
          </div>
        )}

        <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wide mt-4 mb-1.5">
          Reason (required)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="Needs the payout endpoint from Tech before this can be tested…"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-pink-500 disabled:opacity-60"
        />

        {err && (
          <div className="flex items-start gap-2 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{err}</p>
          </div>
        )}

        <div className="flex gap-3 mt-4">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !picked || cycles || tooShort}
            className="flex-1 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            Mark blocked
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Reason modal ──────────────────────────────────────────────────────────────

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
      <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-700 rounded-2xl p-6 shadow-2xl">
        <h2 className="text-white font-semibold">{title}</h2>
        <p className="text-zinc-400 text-sm mt-1 mb-4 leading-relaxed">{blurb}</p>

        <label className="block text-zinc-400 text-xs font-medium uppercase tracking-wide mb-1.5">
          Reason (required)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder={placeholder}
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-pink-500 disabled:opacity-60"
        />
        {tooShort && reason.length > 0 && (
          <p className="text-zinc-500 text-xs mt-1">At least {MIN_REASON} characters.</p>
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
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || tooShort}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── New ticket modal ──────────────────────────────────────────────────────────

function NewTicketModal({
  form, setForm, staffByDept, submitting, onCancel, onCreate,
}: {
  form: NewTicketForm
  setForm: (f: NewTicketForm) => void
  staffByDept: Record<Dept, DeptStaffMember[]>
  submitting: boolean
  onCancel: () => void
  onCreate: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">New Ticket</h2>
          <button onClick={onCancel} className="text-zinc-500 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Title *</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
              placeholder="Ticket title"
            />
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 resize-none"
              placeholder="Describe the issue or feature"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Category</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as Category })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Priority</label>
              <select
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
              >
                {[...PRIORITIES].reverse().map((p) => (
                  <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Assign To Team</label>
              <select
                value={form.assignedTeam}
                onChange={(e) => setForm({ ...form, assignedTeam: e.target.value as Dept, assignedTo: '' })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
              >
                {DEPT_NAMES.map((d) => (
                  <option key={d} value={d}>{DEPT_LABELS[d]}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs text-zinc-400 mb-1 block">
              Assign To Person <span className="text-zinc-600">(optional — leave unassigned for whole team)</span>
            </label>
            <select
              value={form.assignedTo}
              onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="">— Unassigned ({DEPT_LABELS[form.assignedTeam]} team) —</option>
              {(staffByDept[form.assignedTeam] ?? []).map((m) => (
                <option key={m.uid} value={m.uid}>{m.name}</option>
              ))}
            </select>
          </div>

          <p className="text-zinc-600 text-xs flex items-center gap-1.5">
            <Users size={12} /> Dependencies are set from the board — create the ticket, then use
            &ldquo;Mark blocked&rdquo; on its card.
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onCreate}
            disabled={submitting || !form.title.trim()}
            className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            Create Ticket
          </button>
        </div>
      </div>
    </div>
  )
}

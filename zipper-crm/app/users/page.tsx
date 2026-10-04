'use client'

/**
 * Every registered user.
 *
 * The profile itself is still read from Firestore, because that is where the
 * Android app keeps it and it is live app state. Everything done *to* an
 * account goes through the API — the row actions below call `api.users.*`, so a
 * ban is attributed to whoever pressed the button and lands in the audit log.
 *
 * Three things this screen refuses to do:
 *
 *   • **Filter a partial fetch and call it an answer.** The chips are query
 *     constraints, so "banned" means every banned user, not the banned users
 *     that happened to be on screen. The one exception is "active", which
 *     cannot be queried and says so where it is applied.
 *   • **Search only what is loaded.** The term goes to Firestore (exact uid /
 *     email / phone, plus name prefix) and what comes back is the whole result
 *     set, capped and labelled as capped.
 *   • **Hide a button that might be refused.** If the API says no, its words
 *     are what you read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  collection, getCountFromServer, getDocs, limit as fsLimit, orderBy, query, startAfter,
  where,
  type DocumentData, type QueryConstraint, type QueryDocumentSnapshot, type Timestamp,
} from 'firebase/firestore'
import {
  AlertTriangle, ArrowDown, Check, Download, Loader2, RefreshCw, Search, Shield,
  ShieldOff, Star, X, type LucideIcon,
} from 'lucide-react'
import { db } from '@/lib/firebase'
import { searchUsers, type UserRecord } from '@/lib/firestore'
import { downloadCsv } from '@/components/ui/DataTable'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import {
  DEFAULT_SUSPENSION, SuspendDuration, suspensionDays, suspensionProblem,
  suspensionResult, type SuspensionTerm,
} from '@/components/SuspendDuration'

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member',
  'finance_admin', 'support_admin', 'support_member', 'tech_admin',
]

const PAGE_SIZE = 25
/** Search asks the server for at most this many matches, and says when it caps. */
const SEARCH_LIMIT = 100
const DEBOUNCE_MS = 300
const MIN_REASON = 3

// ── What the screen can be asked for ─────────────────────────────────────────

type FilterKey = 'all' | 'hosts' | 'sellers' | 'banned' | 'active'
type SortKey = 'newest' | 'diamonds' | 'beans'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'hosts', label: 'Hosts' },
  { key: 'sellers', label: 'Sellers' },
  { key: 'banned', label: 'Banned' },
  { key: 'active', label: 'Active' },
]

/**
 * Each sort is an `orderBy` the database performs, which is what makes the
 * cursor correct across pages. The cost is that Firestore cannot order a
 * document that has no value for the field — that is stated in the UI rather
 * than quietly dropping people.
 */
const SORTS: Record<SortKey, { label: string; field: string; missingNote: string }> = {
  newest: {
    label: 'Newest first',
    field: 'createdAt',
    missingNote: 'an account with no join date recorded',
  },
  diamonds: {
    label: 'Most diamonds',
    field: 'diamonds',
    missingNote: 'an account that has never held diamonds',
  },
  beans: {
    label: 'Most beans',
    field: 'beans',
    missingNote: 'an account that has never held beans',
  },
}

type Cursor = QueryDocumentSnapshot<DocumentData> | null
type Counts = Partial<Record<FilterKey, number>>

// ── Row actions ──────────────────────────────────────────────────────────────

type ActionKey = 'ban' | 'unban' | 'suspend' | 'resume' | 'grant_host'

interface ActionSpec {
  key: ActionKey
  label: string
  icon: LucideIcon
  title: string
  /** What this does, in terms of what the user will experience. */
  effect: string
  confirmLabel: string
  reasonHint: string
  className: string
}

const ACTIONS: Record<ActionKey, ActionSpec> = {
  ban: {
    key: 'ban',
    label: 'Ban',
    icon: ShieldOff,
    title: 'Ban this account',
    effect:
      'The account is locked out of the app immediately — moderation needs no owner signature. The reason is stored on the account and in the audit log, against your name.',
    confirmLabel: 'Ban the account',
    reasonHint: 'What did they do? This is what the next person reviewing the account will read.',
    className: 'bg-red-500/10 hover:bg-red-500/20 border-red-500/30 text-red-300',
  },
  unban: {
    key: 'unban',
    label: 'Unban',
    icon: Shield,
    title: 'Lift the ban',
    effect:
      'The account can sign in again. The original ban reason is kept as the previous ban reason, so a repeat offender does not read as a first-timer.',
    confirmLabel: 'Lift the ban',
    reasonHint: 'Why is the ban being lifted? An appeal, a mistake, time served…',
    className: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/30 text-green-300',
  },
  suspend: {
    key: 'suspend',
    label: 'Suspend',
    icon: AlertTriangle,
    title: 'Suspend this account',
    effect:
      'The account cannot use the app, but no device is barred — the person can sign in with a different, eligible account on the same phone. A timed suspension ends by itself on the scheduled sweep; an indefinite one waits for somebody to press Resume. It is lifted with Resume, not Unban.',
    confirmLabel: 'Suspend the account',
    reasonHint: 'What did they do? This is what the next person reviewing the account will read.',
    className: 'bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30 text-yellow-300',
  },
  resume: {
    key: 'resume',
    label: 'Resume',
    icon: Shield,
    title: 'End the suspension',
    effect:
      'The account becomes active again. Resume is not the same call as Unban — a suspension never barred a device, so there is nothing device-side to undo, and the server refuses Unban on a suspended account for that reason.',
    confirmLabel: 'Resume the account',
    reasonHint: 'Why is the suspension ending early? An appeal, a mistake, time served…',
    className: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/30 text-green-300',
  },
  grant_host: {
    key: 'grant_host',
    label: 'Make host',
    icon: Star,
    title: 'Make this user a host',
    effect:
      'The user can go live. Their existing agency link is left alone — use the account page if it needs to change.',
    confirmLabel: 'Grant host',
    reasonHint: 'Why they are being made a host.',
    className: 'bg-yellow-500/10 hover:bg-yellow-500/20 border-yellow-500/30 text-yellow-300',
  },
}

// ── Mapping and formatting ───────────────────────────────────────────────────

function mapUser(d: QueryDocumentSnapshot<DocumentData>): UserRecord {
  const data = d.data()
  return {
    uid: d.id,
    name: data.name ?? '',
    email: data.email ?? '',
    phoneNumber: data.phoneNumber ?? '',
    photoUrl: data.photoUrl ?? '',
    diamonds: data.diamonds ?? 0,
    beans: data.beans ?? 0,
    isHost: data.isHost ?? false,
    isAgent: data.isAgent ?? false,
    isSeller: data.isSeller ?? false,
    isBanned: data.isBanned ?? false,
    isSuspended: data.isSuspended ?? false,
    accountState: data.accountState ?? '',
    // A third copy of the same mapper, and a third copy of the same bug: `?? 1`
    // on a field nothing writes reported every account on the platform as
    // Level 1. See the note on UserRecord.level in lib/firestore.ts.
    level: data.level ?? 0,
    hostLevel: data.hostLevel ?? 0,
    agencyId: data.agencyId ?? '',
    createdAt: data.createdAt ?? null,
  }
}

function formatJoined(ts: Timestamp | null): string {
  if (!ts) return '—'
  try { return new Date(ts.toMillis()).toLocaleDateString('en-IN') } catch { return '—' }
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return fallback
}

/**
 * "Active" is the only filter that cannot be a query: a user document written
 * before the ban flag existed has no `isBanned` field at all, and `== false`
 * would silently skip every one of them. So it is applied to what came back,
 * and the page says as much.
 */
function applyActiveFilter(rows: UserRecord[], filter: FilterKey): UserRecord[] {
  return filter === 'active' ? rows.filter((u) => !u.isBanned) : rows
}

/** Cursor paging should not repeat a row, but a duplicate on screen would be
 *  read as two accounts. Cheap insurance. */
function dedupe(rows: UserRecord[]): UserRecord[] {
  const seen = new Set<string>()
  const out: UserRecord[] = []
  for (const u of rows) {
    if (seen.has(u.uid)) continue
    seen.add(u.uid)
    out.push(u)
  }
  return out
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function UsersPage() {
  const router = useRouter()
  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [term, setTerm] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<SortKey>('newest')

  const [rows, setRows] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [counts, setCounts] = useState<Counts>({})
  const [countsFailed, setCountsFailed] = useState(false)

  const [pending, setPending] = useState<{ spec: ActionSpec; user: UserRecord } | null>(null)
  const [notice, setNotice] = useState('')

  const cursorRef = useRef<Cursor>(null)
  // Bumped on every fetch so a slow first page cannot overwrite a newer one.
  const requestRef = useRef(0)

  const searching = searchTerm.trim().length > 0

  // Debounce the typed term before it becomes a request.
  useEffect(() => {
    const handle = setTimeout(() => setSearchTerm(term), DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [term])

  const fetchPage = useCallback(
    async (mode: 'first' | 'more') => {
      const ticket = ++requestRef.current
      if (mode === 'first') {
        cursorRef.current = null
        setLoading(true)
        setRows([])
      } else {
        setLoadingMore(true)
      }
      setError('')

      try {
        if (searching) {
          // Whole-database lookup. No local filtering of a partial fetch: what
          // comes back is everything the server could match.
          const found = await searchUsers(searchTerm.trim(), SEARCH_LIMIT)
          if (ticket !== requestRef.current) return
          setRows(applyActiveFilter(found, filter))
          setHasMore(false)
          return
        }

        const constraints: QueryConstraint[] = []
        // Only "true" flags can be queried — see applyActiveFilter.
        if (filter === 'banned') constraints.push(where('isBanned', '==', true))
        if (filter === 'hosts') constraints.push(where('isHost', '==', true))
        if (filter === 'sellers') constraints.push(where('isSeller', '==', true))

        constraints.push(orderBy(SORTS[sort].field, 'desc'))
        const cursor = mode === 'more' ? cursorRef.current : null
        if (cursor) constraints.push(startAfter(cursor))
        constraints.push(fsLimit(PAGE_SIZE))

        const snap = await getDocs(query(collection(db, 'users'), ...constraints))
        if (ticket !== requestRef.current) return

        const fetched = applyActiveFilter(snap.docs.map(mapUser), filter)
        cursorRef.current = snap.docs[snap.docs.length - 1] ?? cursorRef.current
        setHasMore(snap.docs.length === PAGE_SIZE)
        setRows((prev) => (mode === 'first' ? fetched : dedupe([...prev, ...fetched])))
      } catch (err) {
        if (ticket !== requestRef.current) return
        console.error(err)
        setError(messageOf(err, 'Could not load users.'))
        setHasMore(false)
      } finally {
        // A superseded "load more" must still clear its own spinner, or the
        // button stays stuck on "Loading…" for the rest of the session.
        if (mode === 'more') setLoadingMore(false)
        else if (ticket === requestRef.current) setLoading(false)
      }
    },
    [searching, searchTerm, filter, sort],
  )

  useEffect(() => {
    if (!canView) return
    fetchPage('first')
  }, [canView, fetchPage, reloadKey])

  /**
   * Counts come from `count()` aggregations over the whole collection, not from
   * the rows on screen — a chip that counted the loaded page would say "3
   * banned" next to a list of thousands.
   */
  const loadCounts = useCallback(async () => {
    if (!canView) return
    setCountsFailed(false)
    try {
      const usersRef = collection(db, 'users')
      const [all, hosts, sellers, banned] = await Promise.all([
        getCountFromServer(query(usersRef)),
        getCountFromServer(query(usersRef, where('isHost', '==', true))),
        getCountFromServer(query(usersRef, where('isSeller', '==', true))),
        getCountFromServer(query(usersRef, where('isBanned', '==', true))),
      ])
      const total = all.data().count
      const bannedCount = banned.data().count
      setCounts({
        all: total,
        hosts: hosts.data().count,
        sellers: sellers.data().count,
        banned: bannedCount,
        active: Math.max(total - bannedCount, 0),
      })
    } catch {
      // A count is a nicety. Losing it must not take the list with it.
      setCounts({})
      setCountsFailed(true)
    }
  }, [canView])

  useEffect(() => { loadCounts() }, [loadCounts, reloadKey])

  const refreshAll = useCallback(() => setReloadKey((k) => k + 1), [])

  const exportRows = useCallback(() => {
    const header = [
      'uid', 'name', 'email', 'phone', 'level', 'diamonds', 'beans',
      'host', 'seller', 'agent', 'banned', 'joined',
    ]
    downloadCsv(
      [
        header,
        ...rows.map((u) => [
          u.uid, u.name, u.email, u.phoneNumber, u.level, u.diamonds, u.beans,
          String(u.isHost), String(u.isSeller), String(u.isAgent), String(u.isBanned),
          formatJoined(u.createdAt),
        ]),
      ],
      'users',
    )
  }, [rows])

  const actionsFor = useCallback((u: UserRecord): ActionSpec[] => {
    /*
     * Which reversal to offer, and why `isBanned` alone cannot answer it.
     *
     * `isBanned` is the app's "cannot use the app" gate and it is true for a
     * SUSPENSION as well as a ban. So this row used to offer Unban on every
     * suspended account — and the server refuses that with "use Resume",
     * because a suspension never barred a device and unbanning would go looking
     * for device bans to lift that do not exist.
     *
     * `accountState` is what distinguishes them. The boolean fallbacks are for
     * documents written before that field existed.
     */
    const suspended = u.accountState === 'suspended' || (u.isSuspended === true && !u.accountState)
    const banned = u.accountState === 'banned' || (u.isBanned && !suspended)
    const list: ActionSpec[] = [
      banned ? ACTIONS.unban : suspended ? ACTIONS.resume : ACTIONS.ban,
    ]
    // The lighter of the two restrictions, offered next to the heavier one and
    // only where it can be applied. `states: ['active']` on the account page
    // says the same thing — the server refuses a suspension on an account that
    // is already restricted, and a button whose only outcome is a refusal
    // teaches the operator nothing.
    if (!banned && !suspended) list.push(ACTIONS.suspend)
    if (!u.isHost) list.push(ACTIONS.grant_host)
    return list
  }, [])

  const sortNote = useMemo(() => SORTS[sort], [sort])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="user records" />

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Users</h1>
          <p className="text-slate-400 text-sm mt-1">
            Search runs against the whole database. Click a row for the full record, its history and
            the rest of the actions.
          </p>
        </div>
        <button
          onClick={refreshAll}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
            <p className="text-green-100 text-sm">{notice}</p>
          </div>
          <button onClick={() => setNotice('')} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Search and sort */}
      <div className="flex flex-col lg:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by uid, phone, email or name…"
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex gap-3">
          <div className="relative flex-1 lg:flex-none">
            <ArrowDown size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              disabled={searching}
              title={searching ? 'Search results come back in relevance order, not sorted' : undefined}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 disabled:opacity-40"
            >
              {(Object.keys(SORTS) as SortKey[]).map((k) => (
                <option key={k} value={k}>{SORTS[k].label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={exportRows}
            disabled={rows.length === 0}
            title="Download the rows currently loaded"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-300 rounded-lg px-4 py-2.5 text-sm transition-colors shrink-0"
          >
            <Download size={14} /> Export
          </button>
        </div>
      </div>

      {/* Filter chips, counted across the whole database */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 mb-1">
        {FILTERS.map((f) => {
          const count = counts[f.key]
          const active = filter === f.key
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                active ? 'bg-pink-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {f.label}
              {count != null && (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-slate-900 text-slate-500'
                  }`}
                >
                  {count.toLocaleString('en-IN')}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p className="text-slate-600 text-xs mb-4">
        {countsFailed
          ? 'Counts are unavailable right now — the list itself is unaffected.'
          : 'Counts are for every user in the database, not just the rows loaded below.'}
      </p>

      {searching && (
        <Warning>
          Searching every user by <strong>uid, email and phone</strong> (exact) and by{' '}
          <strong>name prefix</strong>. Firestore cannot match text in the middle of a name, so
          &ldquo;han&rdquo; will not find &ldquo;Chandan&rdquo; — search the phone or uid for that.
          Sorting is off while searching.
        </Warning>
      )}

      {!searching && (
        <Warning>
          Sorted by <strong>{sortNote.label.toLowerCase()}</strong>, which the database does. Any
          user document with no <code className="text-amber-200">{sortNote.field}</code> value —{' '}
          {sortNote.missingNote} — cannot be placed in that order and is not listed under this sort.
          Search by uid or phone to reach one, or switch sort.
        </Warning>
      )}

      {!searching && filter === 'active' && (
        <Warning>
          &ldquo;Active&rdquo; means not banned, and is the one filter applied after each page is
          fetched — a user document written before the ban flag existed has no field to query on. A
          page can therefore show fewer than {PAGE_SIZE} rows. Nobody is hidden: keep loading.
        </Warning>
      )}

      {/* Body */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <TableSkeleton />
        ) : error ? (
          <ErrorState message={error} onRetry={refreshAll} />
        ) : rows.length === 0 ? (
          <Empty
            title={searching ? 'No user matches that' : 'No users to show'}
            hint={
              searching
                ? 'Try the full phone number, the email address, or the uid. A partial name only matches from the start.'
                : 'Clear the filter, or switch the sort — a user with no value for the sorted field is not listed under it.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 text-left">
                  {['User', 'Phone', 'Level', 'Diamonds', 'Beans', 'Status', 'Joined', ''].map(
                    (h, i) => (
                      <th
                        key={h || `actions-${i}`}
                        className={`px-4 sm:px-5 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide whitespace-nowrap ${
                          h === 'Diamonds' || h === 'Beans' ? 'text-right' : ''
                        } ${['Phone', 'Level', 'Diamonds', 'Beans', 'Joined'].includes(h) ? 'hidden sm:table-cell' : ''}`}
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr
                    key={u.uid}
                    onClick={() => router.push(`/users/${u.uid}`)}
                    className="border-b border-slate-800/60 last:border-0 cursor-pointer hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-4 sm:px-5 py-3.5 text-sm">
                      <div className="flex items-center gap-2.5">
                        {u.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={u.photoUrl} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-400 text-xs font-bold shrink-0">
                            {u.name?.[0]?.toUpperCase() ?? '?'}
                          </div>
                        )}
                        <div className="min-w-0">
                          <p className="text-white font-medium truncate">{u.name || '—'}</p>
                          <p className="text-slate-500 text-xs truncate">{u.email || u.uid}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 hidden sm:table-cell">
                      <span className="font-mono text-xs text-slate-300">{u.phoneNumber || '—'}</span>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 hidden sm:table-cell">
                      {/* A host's level means their HOST level — the beans ladder
                          that sets their call rate — not the XP ladder. This is a
                          mixed list, so the row says which one it is showing. */}
                      <span
                        className="text-slate-300 text-xs bg-slate-800 px-2 py-0.5 rounded"
                        title={u.isHost ? 'Host level (beans earned)' : 'User level (XP)'}
                      >
                        {u.isHost ? `Host Lv ${u.hostLevel}` : `Lv ${u.level}`}
                      </span>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 text-right hidden sm:table-cell">
                      <span className="text-blue-300 text-sm tabular-nums">
                        {u.diamonds.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 text-right hidden sm:table-cell">
                      <span className="text-green-300 text-sm tabular-nums">
                        {u.beans.toLocaleString('en-IN')}
                      </span>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {u.isBanned && <Badge tone="red">Banned</Badge>}
                        {u.isHost && <Badge tone="yellow">Host</Badge>}
                        {u.isSeller && <Badge tone="purple">Seller</Badge>}
                        {u.isAgent && <Badge tone="blue">Agent</Badge>}
                        {!u.isBanned && !u.isHost && !u.isSeller && !u.isAgent && (
                          <Badge tone="green">Active</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 hidden sm:table-cell">
                      <span className="text-slate-400 text-xs whitespace-nowrap">
                        {formatJoined(u.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 sm:px-5 py-3.5 text-right">
                      <div
                        className="flex justify-end gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {actionsFor(u).map((spec) => (
                          <button
                            key={spec.key}
                            onClick={() => { setNotice(''); setPending({ spec, user: u }) }}
                            className={`inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${spec.className}`}
                          >
                            <spec.icon size={12} /> {spec.label}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer: cursor pagination, one page at a time and only when asked */}
      {!loading && !error && rows.length > 0 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-3">
          <p className="text-slate-600 text-xs">
            {rows.length.toLocaleString('en-IN')} loaded
            {searching && rows.length >= SEARCH_LIMIT && (
              <span className="text-amber-400/80">
                {' '}· capped at the first {SEARCH_LIMIT} matches, more exist beyond this
              </span>
            )}
            {!searching && !hasMore && ' · end of the list'}
          </p>

          {!searching && hasMore && (
            <button
              onClick={() => fetchPage('more')}
              disabled={loadingMore}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loadingMore ? (
                <><Loader2 size={14} className="animate-spin" /> Loading…</>
              ) : (
                <>Load {PAGE_SIZE} more</>
              )}
            </button>
          )}
        </div>
      )}

      {pending && (
        <ReasonModal
          spec={pending.spec}
          user={pending.user}
          onClose={() => setPending(null)}
          onDone={(message) => {
            setPending(null)
            setNotice(message)
            refreshAll()
          }}
        />
      )}
    </div>
  )
}

// ── Reason modal ─────────────────────────────────────────────────────────────

/**
 * Every mutating call takes a reason and the API refuses without one, so it is
 * collected here rather than sent and rejected. Not `window.prompt`: a prompt
 * cannot say what the action does, and cannot show the refusal afterwards.
 *
 * A reason is not the only thing an action can need. Suspend also needs a
 * TERM, and for a while this dialog did not ask for one — so `days` went
 * unsent, the API read that as "indefinite", and suspending from a row quietly
 * produced a restriction nothing would ever lift. The control is the account
 * page's own, imported rather than rebuilt: see components/SuspendDuration.
 */
function ReasonModal({
  spec, user, onClose, onDone,
}: {
  spec: ActionSpec
  user: UserRecord
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [term, setTerm] = useState<SuspensionTerm>(DEFAULT_SUSPENSION)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ message: string; isRule: boolean } | null>(null)

  const who = user.name || user.uid

  async function submit() {
    const why = reason.trim()
    if (why.length < MIN_REASON) {
      setFailure({
        message: `A reason of at least ${MIN_REASON} characters is required — it is what the audit log stores.`,
        isRule: true,
      })
      return
    }

    // The server's bounds, checked before the call rather than after it — the
    // same check the account page makes, out of the same module.
    if (spec.key === 'suspend') {
      const problem = suspensionProblem(term)
      if (problem) {
        setFailure({ message: problem, isRule: true })
        return
      }
    }

    setBusy(true)
    setFailure(null)
    try {
      switch (spec.key) {
        case 'ban':
          await api.users.ban(user.uid, why)
          onDone(`${who} is banned. They are locked out of the app now.`)
          break
        case 'unban':
          await api.users.unban(user.uid, why)
          onDone(`Ban lifted for ${who}. The reason it was imposed is kept as the previous ban reason.`)
          break
        case 'suspend': {
          const days = suspensionDays(term)
          // `suspended_until` is on the response of `suspend_user` and on no
          // other moderation call, so it is read off this one rather than
          // widened into the shared `ModerationResult`.
          const res = (await api.users.suspend(user.uid, why, days)) as {
            suspended_until?: string
          }
          onDone(`${who}: ${suspensionResult(days, res.suspended_until)}`)
          break
        }
        case 'resume':
          await api.users.resume(user.uid, why)
          onDone(`Suspension lifted. ${who} can use the app again.`)
          break
        case 'grant_host':
          await api.users.grantHost(user.uid, why)
          onDone(`${who} is now a host and can go live.`)
          break
      }
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{spec.title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{who}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">{spec.effect}</p>

          {spec.key === 'suspend' && (
            <SuspendDuration value={term} onChange={setTerm} />
          )}

          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5">
              Reason <span className="text-pink-400">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder={spec.reasonHint}
              className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
            />
            <p className="text-slate-600 text-xs mt-1">
              At least {MIN_REASON} characters. It is stored in the audit log and read back on the
              account history.
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
            onClick={onClose}
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
              <><spec.icon size={15} /> {spec.confirmLabel}</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className={`flex items-center gap-3 px-4 sm:px-5 py-4 animate-pulse ${
            i > 0 ? 'border-t border-slate-800/60' : ''
          }`}
        >
          <div className="w-8 h-8 rounded-full bg-slate-800 shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="h-3 bg-slate-800 rounded w-32 max-w-full" />
            <div className="h-2.5 bg-slate-800/60 rounded w-48 max-w-full" />
          </div>
          <div className="hidden sm:block h-3 bg-slate-800 rounded w-16 shrink-0" />
          <div className="hidden sm:block h-3 bg-slate-800 rounded w-14 shrink-0" />
          <div className="h-6 bg-slate-800 rounded w-16 shrink-0" />
        </div>
      ))}
    </div>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'red' | 'yellow' | 'purple' | 'blue' | 'green'
}) {
  const tones = {
    red: 'bg-red-500/20 text-red-400 border-red-500/30',
    yellow: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    purple: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
    blue: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    green: 'bg-green-500/10 text-green-400 border-green-500/20',
  }
  return (
    <span className={`px-1.5 py-0.5 border rounded text-[10px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  )
}

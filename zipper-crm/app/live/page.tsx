'use client'

/**
 * Live monitoring — watch, and act.
 *
 * Rooms are real-time app state, so they are read from Firestore directly
 * (`getActiveLiveRooms`). Every *action* goes through the API so it lands in the
 * audit log against a named actor: warning and banning a host through
 * `api.users.*`, and ending a stream or muting a host through
 * `apiPartners.live.*`. **Nothing on this page writes to Firestore.**
 *
 * That last sentence used to be false in the worst way. Ending a stream was
 * `updateDoc(liveRooms/{id}, { isActive: false })` straight from the browser —
 * a change with no actor, no reason and no audit entry, where the only evidence
 * a broadcast had been cut was that it had stopped. The control was removed
 * rather than fixed, and sat here disabled with the reason written on it until
 * `POST /users/live-rooms/{id}/end` existed. It does now.
 *
 * Three things this screen deliberately does not hide:
 *
 *   1. The refresh. It polls, and the interval is visible and pausable — a page
 *      that silently refetches under a reader's cursor is hostile.
 *   2. What ending a room actually does. It flags the room ended; the stream
 *      stops when the host's client reads the flag, so the room can linger for
 *      a moment. The server says so and this page prints what the server said.
 *   3. What muting does NOT do. `hostMuted` is a flag the **Android app must
 *      honour**; the API is not in the media path and cannot silence anybody.
 *      Until the app reads it, a mute has changed nothing the audience can hear.
 *      That sentence comes back on every response and is shown every time.
 *
 * Flagging is explained wherever it appears. An unexplained red badge is noise:
 * every flag carries the numbers that produced it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Ban, CheckCircle2, Clock, Eye, ExternalLink, Flame, Gift,
  Loader2, MicOff, Pause, Play, Radio, RefreshCw, ShieldAlert, TrendingUp,
  Users, X,
} from 'lucide-react'
import { getActiveLiveRooms, type LiveRoom } from '@/lib/firestore'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { live } from '@/lib/apiPartners'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import LiveWatch from '@/components/LiveWatch'

// ── Access ────────────────────────────────────────────────────────────────────

const PAGE_ROLES: CrmRole[] = [
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'tech_admin', 'tech_member',
  'support_admin',
]

/** Watching is broad. Acting on a host is not. */
const MODERATOR_ROLES: CrmRole[] = ['app_admin', 'app_member', 'ops_admin', 'ops_member']

/**
 * Narrower again: cutting a broadcast off in front of its audience.
 *
 * Spec 3.4.5 / 8.7.3 — Ops monitors live rooms and intervenes; owners can do
 * anything. The app team may warn and ban and may not end or mute, which is the
 * line `_require_intervener` draws in `backend/app/routers/users.py`.
 *
 * Read off the **API identity**, not the Firestore role, for the same reason
 * `/sellers/[id]` reads `apiUser.role === 'owner'` before showing an execute
 * button: the API is what decides, `owner` is an API role that does not exist in
 * `crmUsers`, and a Firestore `superadmin` is not automatically either of these.
 *
 * It is a **display** rule and not a control. The API refuses with a message
 * written to be shown; disabling the button here only saves somebody a round
 * trip to be told no.
 */
const INTERVENE_API_ROLES = ['owner', 'ops_admin', 'ops_member'] as const

// ── Polling ───────────────────────────────────────────────────────────────────

const INTERVALS = [15, 30, 60, 120] as const
const DEFAULT_INTERVAL = 30

// ── Flag thresholds ───────────────────────────────────────────────────────────
//
// A flag has to be explainable in one sentence, so the rules are deliberately
// blunt and the numbers that triggered them are always shown.

/** Gifts/min in the recent window must be at least this multiple of the room's own average. */
const SPIKE_FACTOR = 3
/** …and at least this many gifts/min, so a room averaging 0.2 does not flag on a single gift. */
const SPIKE_MIN_RATE = 10
/** Only samples from this window count as "recent". */
const SPIKE_WINDOW_MS = 10 * 60 * 1000
/** Two samples less than this far apart cannot produce a trustworthy rate. */
const SPIKE_MIN_SPAN_MIN = 0.6

/** Viewer count must be at least this multiple of the median live room… */
const VIEWER_FACTOR = 4
/** …and at least this many viewers in absolute terms. */
const VIEWER_FLOOR = 200
/** Below this many concurrent rooms there is no meaningful "typical" to compare against. */
const VIEWER_MIN_POPULATION = 3

/** Gift samples older than this are dropped; also the window for "gifts in the last hour". */
const HISTORY_MS = 60 * 60 * 1000

// ── Types ─────────────────────────────────────────────────────────────────────

interface Flag {
  label: string
  /** Why this fired, in numbers. Shown next to the badge — never a bare badge. */
  detail: string
}

interface Snapshot {
  rooms: LiveRoom[]
  flags: Record<string, Flag[]>
  /** Gift deltas summed across every room observed inside the history window. */
  giftsInWindow: number
  /** How far back the gift observations actually reach, in ms. */
  windowMs: number
  at: number
}

type GiftSample = { at: number; gifts: number }

/**
 * The four things this screen can do to a live room, in ascending severity.
 *
 * `warn` and `ban` act on the **host's account** and are unchanged.
 * `mute` and `end` act on the **room**, are new, and are Ops-or-owner only.
 */
type RoomAction = 'warn' | 'ban' | 'mute' | 'end'

interface ActionCopy {
  title: (room: LiveRoom) => string
  /** What this actually does, including what it does not do. */
  blurb: string
  confirmLabel: string
  tone: 'danger' | 'warning'
  /** True for the two that need Ops or an owner rather than a moderator. */
  intervention: boolean
}

const ACTION: Record<RoomAction, ActionCopy> = {
  warn: {
    title: (r) => `Warn ${r.hostName || 'this host'}`,
    blurb:
      'A formal warning is recorded on the account and shown in their history. The stream keeps running. Recorded in the audit log with your name.',
    confirmLabel: 'Warn host',
    tone: 'warning',
    intervention: false,
  },
  ban: {
    title: (r) => `Ban ${r.hostName || 'this host'}`,
    blurb:
      'The account is banned immediately. This does not close the room — the stream stays up until the host’s client drops it, so end the room as well if it needs to stop now. Recorded in the audit log with your name.',
    confirmLabel: 'Ban host',
    tone: 'danger',
    intervention: false,
  },
  mute: {
    title: (r) => `Mute ${r.hostName || 'this host'}`,
    blurb:
      'Sets the mute flag on the room and records why. It is an instruction the Android app has to honour by stopping the host’s audio — this API is not in the media path and cannot silence anybody on its own, so if the app does not read the flag yet, nothing the audience can hear changes. The server says which it was and that answer is shown.',
    confirmLabel: 'Mute host',
    tone: 'warning',
    intervention: true,
  },
  end: {
    title: (r) => `End ${r.hostName ? `${r.hostName}’s stream` : 'this stream'}`,
    blurb:
      'The room is flagged ended and the reason goes in the audit log with your name. The stream itself stops when the host’s client reads that flag, so the room can stay listed for a moment. The host’s account is untouched — ending a room is not a ban.',
    confirmLabel: 'End stream',
    tone: 'danger',
    intervention: true,
  },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const num = (n: number) => n.toLocaleString('en-IN')

function startedAtMs(room: LiveRoom): number {
  const ts = room.startedAt
  if (!ts) return 0
  try { return ts.toMillis() } catch { return 0 }
}

function durationLabel(room: LiveRoom, now: number): string {
  const ms = startedAtMs(room)
  if (!ms) return 'unknown'
  const mins = Math.max(0, Math.floor((now - ms) / 60000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LiveMonitor() {
  const { crmUser, apiUser, loading: authLoading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)
  const canModerate = !!crmUser && canAccess(crmUser, MODERATOR_ROLES)
  const canIntervene = INTERVENE_API_ROLES.some((r) => r === apiUser?.role)

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [staleWarning, setStaleWarning] = useState('')
  /** The room whose video is open, if any. */
  const [watching, setWatching] = useState<LiveRoom | null>(null)
  const [notice, setNotice] = useState('')

  const [intervalSec, setIntervalSec] = useState<number>(DEFAULT_INTERVAL)
  const [paused, setPaused] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number>(DEFAULT_INTERVAL)
  const [now, setNow] = useState(() => Date.now())

  const [moderating, setModerating] = useState<{ room: LiveRoom; action: RoomAction } | null>(null)
  /**
   * The server's own sentence about what a mute did — kept and shown, not
   * summarised. It says the Android app must honour the flag and that nothing
   * the audience can hear has changed until it does. Reporting "muted" without
   * it would be the screen overstating the endpoint.
   */
  const [caveat, setCaveat] = useState('')

  // Gift history, keyed by room id. A ref because it is an accumulating side
  // record of what polling has seen, not something the render reads directly.
  const historyRef = useRef<Map<string, GiftSample[]>>(new Map())
  const observingSinceRef = useRef<number>(Date.now())

  const applySnapshot = useCallback((rooms: LiveRoom[]) => {
    const at = Date.now()
    const history = historyRef.current

    for (const room of rooms) {
      const samples = history.get(room.roomId) ?? []
      samples.push({ at, gifts: room.totalGiftsReceived })
      history.set(room.roomId, samples)
    }

    // Prune: drop samples outside the window, and rooms with nothing left.
    let giftsInWindow = 0
    for (const [id, samples] of Array.from(history.entries())) {
      const kept = samples.filter((s) => at - s.at <= HISTORY_MS)
      if (kept.length === 0) { history.delete(id); continue }
      history.set(id, kept)
      // A room's contribution is what its counter grew by inside the window.
      // Clamped at 0 because a restarted room can reset its counter.
      giftsInWindow += Math.max(0, kept[kept.length - 1].gifts - kept[0].gifts)
    }

    // Viewer baseline for "unusually high" — the median of what is live now.
    const viewerMedian = median(rooms.map((r) => r.viewerCount))

    const flags: Record<string, Flag[]> = {}
    for (const room of rooms) {
      const found: Flag[] = []

      // 1. Gift spike relative to the room's OWN average since it went live.
      const samples = (history.get(room.roomId) ?? []).filter((s) => at - s.at <= SPIKE_WINDOW_MS)
      const startMs = startedAtMs(room)
      const liveMin = startMs ? (at - startMs) / 60000 : 0
      if (samples.length >= 2 && liveMin >= 1) {
        const first = samples[0]
        const last = samples[samples.length - 1]
        const spanMin = (last.at - first.at) / 60000
        if (spanMin >= SPIKE_MIN_SPAN_MIN) {
          const recentRate = Math.max(0, last.gifts - first.gifts) / spanMin
          const ownAverage = room.totalGiftsReceived / liveMin
          if (recentRate >= SPIKE_MIN_RATE && recentRate >= ownAverage * SPIKE_FACTOR) {
            found.push({
              label: 'gift spike',
              detail:
                `${Math.round(recentRate)}/min over the last ${Math.round(spanMin)}m ` +
                `vs ${ownAverage < 1 ? ownAverage.toFixed(1) : Math.round(ownAverage)}/min ` +
                `average for this room since it went live`,
            })
          }
        }
      }

      // 2. Viewer count far above the typical live room right now.
      if (
        rooms.length >= VIEWER_MIN_POPULATION &&
        viewerMedian > 0 &&
        room.viewerCount >= VIEWER_FLOOR &&
        room.viewerCount >= viewerMedian * VIEWER_FACTOR
      ) {
        found.push({
          label: 'high viewers',
          detail:
            `${num(room.viewerCount)} viewers — ` +
            `${(room.viewerCount / viewerMedian).toFixed(1)}× the median live room ` +
            `(${num(Math.round(viewerMedian))})`,
        })
      }

      if (found.length) flags[room.roomId] = found
    }

    setSnapshot({
      rooms,
      flags,
      giftsInWindow,
      // How much history actually backs that number — never more than the
      // window itself, so the label cannot claim an hour it does not have.
      windowMs: Math.min(Math.max(0, at - observingSinceRef.current), HISTORY_MS),
      at,
    })
    setNow(at)
  }, [])

  const refresh = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    else setRefreshing(true)
    try {
      const rooms = await getActiveLiveRooms()
      applySnapshot(rooms)
      setError('')
      setStaleWarning('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not read live rooms.'
      // A failed refresh must not wipe a good snapshot — say it is stale instead.
      if (initial) setError(message)
      else setStaleWarning(`Refresh failed — showing the last good read. ${message}`)
    } finally {
      setLoading(false)
      setRefreshing(false)
      setSecondsLeft(intervalSec)
    }
  }, [applySnapshot, intervalSec])

  useEffect(() => {
    if (!allowed) return
    observingSinceRef.current = Date.now()
    refresh(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed])

  // One second tick: drives the countdown and the live duration readouts.
  useEffect(() => {
    if (!allowed) return
    const id = window.setInterval(() => {
      setNow(Date.now())
      if (!paused) setSecondsLeft((s) => (s > 0 ? s - 1 : 0))
    }, 1000)
    return () => window.clearInterval(id)
  }, [allowed, paused])

  // The refetch fires here rather than inside the tick's state updater — an
  // updater has to be pure, and React is allowed to run it more than once.
  // `refresh` resets the countdown when it settles, which re-arms this.
  useEffect(() => {
    if (!allowed || paused || loading || secondsLeft > 0) return
    refresh()
  }, [allowed, paused, loading, secondsLeft, refresh])

  useEffect(() => { setSecondsLeft(intervalSec) }, [intervalSec])

  const rooms = snapshot?.rooms ?? []
  const flags = snapshot?.flags ?? {}

  const { flagged, rest } = useMemo(() => {
    const f: LiveRoom[] = []
    const n: LiveRoom[] = []
    for (const room of rooms) (flags[room.roomId] ? f : n).push(room)
    // Flagged rooms first, and inside each group the biggest room first.
    f.sort((a, b) => b.viewerCount - a.viewerCount)
    n.sort((a, b) => b.viewerCount - a.viewerCount)
    return { flagged: f, rest: n }
  }, [rooms, flags])

  const totalViewers = rooms.reduce((sum, r) => sum + r.viewerCount, 0)
  const observedMin = Math.floor((snapshot?.windowMs ?? 0) / 60000)

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="live monitoring" />

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <Radio size={26} className="text-pink-500" />
            Live now
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Active rooms straight from Firestore. Moderation goes through the API, so
            every warning and ban is recorded against your name.
          </p>
        </div>

        <RefreshControl
          intervalSec={intervalSec}
          setIntervalSec={setIntervalSec}
          paused={paused}
          setPaused={setPaused}
          secondsLeft={secondsLeft}
          refreshing={refreshing}
          lastAt={snapshot?.at ?? null}
          onRefreshNow={() => refresh()}
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <Stat
          icon={<Radio size={15} className="text-pink-400" />}
          label="Rooms live"
          value={loading ? '—' : num(rooms.length)}
          hint={flagged.length > 0 ? `${flagged.length} flagged` : 'nothing flagged'}
        />
        <Stat
          icon={<Users size={15} className="text-blue-400" />}
          label="Viewers right now"
          value={loading ? '—' : num(totalViewers)}
          hint={rooms.length ? `across ${num(rooms.length)} rooms` : 'no rooms live'}
        />
        <Stat
          icon={<Gift size={15} className="text-amber-400" />}
          label={observedMin >= 60 ? 'Gifts in the last hour' : 'Gifts since this page opened'}
          value={loading ? '—' : num(snapshot?.giftsInWindow ?? 0)}
          hint={
            observedMin >= 60
              ? 'counted from 60 minutes of polling'
              : `only ${observedMin}m of polling so far — this is not yet a full hour`
          }
        />
      </div>

      {staleWarning && <Warning onDismiss={() => setStaleWarning('')}>{staleWarning}</Warning>}

      {notice && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 size={15} className="text-green-400 mt-0.5 shrink-0" />
            <p className="text-green-200 text-sm">{notice}</p>
          </div>
          <button onClick={() => setNotice('')} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* The server's caveat about what a mute did NOT do. Amber, beside the
          green tick, because "recorded" and "enforced" are different claims and
          only one of them is being made. */}
      {caveat && (
        <div className="flex items-start justify-between gap-3 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <MicOff size={15} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-amber-100 text-sm">{caveat}</p>
          </div>
          <button onClick={() => setCaveat('')} className="text-amber-400/70 hover:text-amber-200">
            <X size={14} />
          </button>
        </div>
      )}

      {/* How flagging works — stated once, in plain words, so no badge is a mystery */}
      {!loading && !error && rooms.length > 0 && (
        <div className="flex items-start gap-2 bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 mb-5 text-xs text-slate-400">
          <TrendingUp size={14} className="text-slate-500 mt-0.5 shrink-0" />
          <p>
            A room is flagged when its gift rate over the last few minutes is at least{' '}
            {SPIKE_FACTOR}× its own average since going live (and above {SPIKE_MIN_RATE}/min), or when
            its viewer count is at least {VIEWER_FACTOR}× the median live room and above {num(VIEWER_FLOOR)}.
            {observedMin < 1 && ' Gift-spike detection needs one full refresh cycle before it can say anything.'}
            {' '}
            <span className="text-slate-500">
              Every action on a card goes through the API and is recorded against your name with the
              reason you give. <strong className="text-slate-400">End</strong> flags the room ended —
              the stream stops when the host’s client reads that flag, so it can linger for a moment,
              and the host’s account is untouched. <strong className="text-slate-400">Mute</strong>{' '}
              sets a flag the Android app has to honour; this API is not in the media path and cannot
              silence anybody on its own. Both are Ops or an owner.{' '}
              {!canIntervene && 'Your role can warn and ban, and cannot end or mute.'}
            </span>
          </p>
        </div>
      )}

      {/* Body */}
      {loading ? (
        <Loading label="Reading live rooms…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => refresh(true)} />
      ) : rooms.length === 0 ? (
        <Empty
          icon={<Radio size={28} />}
          title="Nobody is live right now"
          hint={`Rooms appear here on the next refresh${paused ? ' — polling is paused, so refresh manually.' : '.'}`}
        />
      ) : (
        <div className="space-y-8">
          {flagged.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-amber-300 text-sm font-semibold uppercase tracking-widest mb-3">
                <Flame size={15} /> Needs a look ({flagged.length})
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {flagged.map((room) => (
                  <RoomCard
                    key={room.roomId}
                    room={room}
                    flags={flags[room.roomId] ?? []}
                    now={now}
                    canModerate={canModerate}
                    canIntervene={canIntervene}
                    onModerate={(action) => setModerating({ room, action })}
                    onWatch={setWatching}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-slate-400 text-sm font-semibold uppercase tracking-widest mb-3">
              {flagged.length > 0 ? `Everything else (${rest.length})` : `Live rooms (${rest.length})`}
            </h2>
            {rest.length === 0 ? (
              <p className="text-slate-600 text-sm">Every live room is flagged.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {rest.map((room) => (
                  <RoomCard
                    key={room.roomId}
                    room={room}
                    flags={[]}
                    now={now}
                    canModerate={canModerate}
                    canIntervene={canIntervene}
                    onModerate={(action) => setModerating({ room, action })}
                    onWatch={setWatching}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {watching && (
        <LiveWatch
          roomId={watching.roomId}
          hostName={watching.hostName ?? ''}
          onClose={() => setWatching(null)}
        />
      )}

      {moderating && (
        <ReasonModal
          tone={ACTION[moderating.action].tone}
          icon={ACTION_ICON[moderating.action]}
          title={ACTION[moderating.action].title(moderating.room)}
          blurb={ACTION[moderating.action].blurb}
          confirmLabel={ACTION[moderating.action].confirmLabel}
          onCancel={() => setModerating(null)}
          onConfirm={async (reason) => {
            const { room, action } = moderating
            const who = room.hostName || room.hostUid || room.roomId
            setCaveat('')

            if (action === 'ban') {
              await api.users.ban(room.hostUid, reason)
              setNotice(
                `${who} was banned. The room may stay listed until it closes — end it too if it needs to stop now.`,
              )
            } else if (action === 'warn') {
              await api.users.warn(room.hostUid, reason)
              setNotice(`${who} was warned. The stream is still running.`)
            } else if (action === 'end') {
              const result = await live.end(room.roomId, reason)
              // The server's own sentence about what it did and did not do.
              setNotice(`${who}’s stream was ended. ${result.note}`)
            } else {
              const result = await live.mute(room.roomId, true, reason)
              setNotice(`${who} was muted, and the reason is on the record.`)
              setCaveat(result.app_must_honour)
            }

            setModerating(null)
            refresh()
          }}
        />
      )}
    </div>
  )
}

/**
 * Icons live outside `ACTION` because that record is plain data and this file
 * would otherwise be building React nodes at module scope.
 */
const ACTION_ICON: Record<RoomAction, React.ReactNode> = {
  warn: <ShieldAlert size={18} />,
  ban: <Ban size={18} />,
  mute: <MicOff size={18} />,
  end: <X size={18} />,
}

// ── Refresh control ───────────────────────────────────────────────────────────

function RefreshControl({
  intervalSec, setIntervalSec, paused, setPaused, secondsLeft, refreshing, lastAt, onRefreshNow,
}: {
  intervalSec: number
  setIntervalSec: (n: number) => void
  paused: boolean
  setPaused: (b: boolean) => void
  secondsLeft: number
  refreshing: boolean
  lastAt: number | null
  onRefreshNow: () => void
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col gap-2 shrink-0">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPaused(!paused)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            paused
              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'
              : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700'
          }`}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume' : 'Pause'}
        </button>

        <select
          value={intervalSec}
          onChange={(e) => setIntervalSec(Number(e.target.value))}
          disabled={paused}
          title={paused ? 'Polling is paused' : 'How often this page refetches'}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 disabled:opacity-50"
        >
          {INTERVALS.map((s) => (
            <option key={s} value={s}>every {s < 60 ? `${s}s` : `${s / 60}m`}</option>
          ))}
        </select>

        <button
          onClick={onRefreshNow}
          disabled={refreshing}
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 border border-slate-700 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Now
        </button>
      </div>

      <p className="text-xs text-slate-500 text-right tabular-nums">
        {paused
          ? 'Paused — nothing will change under you'
          : refreshing
            ? 'Refreshing…'
            : `Next refresh in ${secondsLeft}s`}
        {lastAt && (
          <span className="text-slate-600">
            {' '}· last {new Date(lastAt).toLocaleTimeString('en-IN')}
          </span>
        )}
      </p>
    </div>
  )
}

// ── Stat ──────────────────────────────────────────────────────────────────────

function Stat({
  icon, label, value, hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex items-center gap-2 text-slate-400 text-xs font-medium uppercase tracking-wide">
        {icon} {label}
      </div>
      <p className="text-white text-2xl font-bold mt-1.5">{value}</p>
      <p className="text-slate-600 text-xs mt-0.5">{hint}</p>
    </div>
  )
}

// ── Room card ─────────────────────────────────────────────────────────────────

function RoomCard({
  room, flags, now, canModerate, canIntervene, onModerate, onWatch,
}: {
  room: LiveRoom
  flags: Flag[]
  now: number
  /** May warn or ban the host's account. */
  canModerate: boolean
  /** May end the room or mute the host — Ops or an owner (8.7.3). */
  canIntervene: boolean
  onModerate: (action: RoomAction) => void
  /** Open the stream itself. Not an act against anybody — see the button. */
  onWatch: (room: LiveRoom) => void
}) {
  const isFlagged = flags.length > 0
  const hasHost = !!room.hostUid

  return (
    <div
      className={`bg-slate-900 border rounded-xl overflow-hidden flex flex-col ${
        isFlagged ? 'border-amber-500/40' : 'border-slate-800'
      }`}
    >
      <div className="p-4 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {hasHost ? (
              <Link
                href={`/users/${room.hostUid}`}
                className="text-white font-medium hover:text-pink-300 inline-flex items-center gap-1.5 truncate"
              >
                {room.hostName || room.hostUid}
                <ExternalLink size={12} className="shrink-0 text-slate-500" />
              </Link>
            ) : (
              <p
                className="text-slate-400 font-medium truncate"
                title="This room has no hostUid recorded, so there is no account to open."
              >
                {room.hostName || 'Unknown host'}
              </p>
            )}
            <p className="text-slate-500 text-xs mt-0.5 truncate">
              {room.title || <span className="italic text-slate-600">no title</span>}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-medium text-green-300 bg-green-500/15 px-2 py-1 rounded-full shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            LIVE
          </span>
        </div>

        {isFlagged && (
          <div className="mt-3 space-y-1.5">
            {flags.map((f) => (
              <div
                key={f.label}
                className="bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-1.5"
              >
                <p className="text-amber-300 text-[11px] font-semibold uppercase tracking-wide flex items-center gap-1">
                  <Flame size={10} /> {f.label}
                </p>
                <p className="text-amber-100/80 text-[11px] mt-0.5 leading-snug">{f.detail}</p>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
          <Metric icon={<Users size={13} />} label="viewers" value={num(room.viewerCount)} />
          <Metric icon={<Gift size={13} />} label="gifts" value={num(room.totalGiftsReceived)} />
          <Metric icon={<Clock size={13} />} label="live for" value={durationLabel(room, now)} />
        </div>

        <p className="text-slate-600 text-[11px] mt-3 truncate" title={room.roomId}>
          room {room.roomId}
        </p>
      </div>

      {/* Watch first, then four actions in ascending severity.
          Watch is deliberately separated and first: it is the only control here
          that is not an act against somebody, and it is the one that should be
          used before any of the others. Warn and Ban act on the host's account
          and need a hostUid; Mute and End act on the ROOM and work whether or
          not the room recorded who was hosting it. */}
      <button
        onClick={() => onWatch(room)}
        className="w-full border-t border-slate-800 flex items-center justify-center gap-1.5 text-slate-300 hover:text-pink-300 hover:bg-pink-500/10 text-xs py-2.5 transition-colors"
      >
        <Eye size={13} /> Watch this stream
      </button>
      <div className="border-t border-slate-800 grid grid-cols-4 divide-x divide-slate-800">
        <button
          onClick={() => onModerate('warn')}
          disabled={!canModerate || !hasHost}
          title={
            !canModerate
              ? 'Your role cannot act on hosts'
              : !hasHost
                ? 'No hostUid on this room'
                : 'Record a warning against the host'
          }
          className="flex items-center justify-center gap-1.5 text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 disabled:text-slate-700 disabled:hover:bg-transparent disabled:cursor-not-allowed text-xs py-2.5 transition-colors"
        >
          <ShieldAlert size={13} /> Warn
        </button>
        <button
          onClick={() => onModerate('ban')}
          disabled={!canModerate || !hasHost}
          title={
            !canModerate
              ? 'Your role cannot act on hosts'
              : !hasHost
                ? 'No hostUid on this room'
                : 'Ban the host account'
          }
          className="flex items-center justify-center gap-1.5 text-slate-400 hover:text-red-300 hover:bg-red-500/10 disabled:text-slate-700 disabled:hover:bg-transparent disabled:cursor-not-allowed text-xs py-2.5 transition-colors"
        >
          <Ban size={13} /> Ban
        </button>
        <button
          onClick={() => onModerate('mute')}
          disabled={!canIntervene}
          title={
            canIntervene
              ? 'Set the mute flag on this room. The Android app has to honour it — this does not silence the stream on its own.'
              : 'Muting a host is done by Ops or a business owner'
          }
          className="flex items-center justify-center gap-1.5 text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 disabled:text-slate-700 disabled:hover:bg-transparent disabled:cursor-not-allowed text-xs py-2.5 transition-colors"
        >
          <MicOff size={13} /> Mute
        </button>
        <button
          onClick={() => onModerate('end')}
          disabled={!canIntervene}
          title={
            canIntervene
              ? 'End this room, with a reason. The stream stops when the host’s client reads the flag; the host’s account is untouched.'
              : 'Ending a stream is done by Ops or a business owner'
          }
          className="flex items-center justify-center gap-1.5 text-slate-400 hover:text-red-300 hover:bg-red-500/10 disabled:text-slate-700 disabled:hover:bg-transparent disabled:cursor-not-allowed text-xs py-2.5 transition-colors"
        >
          <X size={13} /> End
        </button>
      </div>
    </div>
  )
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-slate-800/50 rounded-lg py-2">
      <div className="flex items-center justify-center text-slate-500 mb-0.5">{icon}</div>
      <p className="text-white text-sm font-semibold">{value}</p>
      <p className="text-slate-600 text-[10px] uppercase tracking-wide">{label}</p>
    </div>
  )
}

// ── Reason modal ──────────────────────────────────────────────────────────────

const MIN_REASON = 6

function ReasonModal({
  title, blurb, confirmLabel, tone, icon, onCancel, onConfirm,
}: {
  title: string
  blurb: string
  confirmLabel: string
  tone: 'danger' | 'warning'
  icon: React.ReactNode
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
      // ApiError.message is what the server actually refused with — show it verbatim.
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not work.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
              tone === 'danger' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
            }`}
          >
            {icon}
          </div>
          <div>
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-400 text-sm mt-1 leading-relaxed">{blurb}</p>
          </div>
        </div>

        <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
          Reason (required)
        </label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder="What happened, in enough detail that this makes sense in six months…"
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
            className={`flex-1 flex items-center justify-center gap-2 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors ${
              tone === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'
            }`}
          >
            {busy && <Loader2 size={15} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

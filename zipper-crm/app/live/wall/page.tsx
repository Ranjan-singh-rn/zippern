'use client'

/**
 * Live wall — every live room at a glance (O13, Owner, 5 Nov 2026).
 *
 *   "Other apps have nudity, sexualism, vulgarities in the live and party rooms. I don't want my application like
 *    that. Make it properly monitored, and keep the people who spread these things away."
 *
 * Each broadcaster's phone sends a still of what it publishes every minute or so (`reportLiveSnapshot`); this page
 * shows the newest still of every live room side by side, refreshing itself, with the rooms the AI check flagged
 * first (when the Owner has turned the check on — Safety settings). One click to watch silently, end the room, warn
 * or ban the host. Beside it, the open safety flags: stills the check flagged and people the word screen silenced —
 * each closed by Ops when dealt with.
 *
 * Reads: `liveRooms` (any signed-in account), the stills in Storage (staff who monitor — storage.rules) and
 * `safetyFlags` (staff — firestore.rules). Every action goes through the API's audited endpoints; closing a flag
 * writes only its status and who closed it.
 */

import { useCallback, useEffect, useState } from 'react'
import { collection, doc, getDocs, limit, query, serverTimestamp, updateDoc, where, type Timestamp } from 'firebase/firestore'
import { getDownloadURL, ref } from 'firebase/storage'
import { AlertTriangle, Ban, CheckCircle2, Eye, ImageOff, RefreshCw, ShieldAlert, Square, Users } from 'lucide-react'
import { db, storage } from '@/lib/firebase'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { live } from '@/lib/apiPartners'
import { Denied, Loading } from '@/components/ui/States'
import LiveWatch from '@/components/LiveWatch'

const PAGE_ROLES: CrmRole[] = ['app_admin', 'app_member', 'ops_admin', 'ops_member', 'tech_admin', 'tech_member', 'support_admin']
const MODERATOR_ROLES: CrmRole[] = ['app_admin', 'app_member', 'ops_admin', 'ops_member']
const INTERVENE_API_ROLES = ['owner', 'ops_admin', 'ops_member'] as const
const REFRESH_SECONDS = 30

interface WallRoom {
  roomId: string
  hostUid: string
  hostName: string
  title: string
  viewers: number
  stillPath: string
  stillAt: Timestamp | null
  flagLevel: string
  visionError: string
  /** The still's download URL, once read. */
  stillUrl?: string
}

interface Flag {
  id: string
  kind: string
  level: string
  roomId: string
  uid: string
  hostUid: string
  words: string[]
  createdAt: Timestamp | null
}

async function readWall(): Promise<WallRoom[]> {
  const snap = await getDocs(query(collection(db, 'liveRooms'), where('isActive', '==', true), limit(200)))
  const rooms: WallRoom[] = snap.docs.map((d) => {
    const x = d.data()
    return {
      roomId: d.id,
      hostUid: String(x.hostUid ?? ''),
      hostName: String(x.hostName ?? ''),
      title: String(x.title ?? ''),
      viewers: Number(x.viewerCount ?? 0) || 0,
      stillPath: String(x.lastSnapshotPath ?? ''),
      stillAt: (x.lastSnapshotAt ?? null) as Timestamp | null,
      flagLevel: String((x.safetyFlag as Record<string, unknown> | undefined)?.level ?? ''),
      visionError: String(x.lastSafeSearchError ?? ''),
    }
  })
  await Promise.all(rooms.map(async (r) => {
    if (!r.stillPath) return
    try { r.stillUrl = await getDownloadURL(ref(storage, r.stillPath)) } catch { /* not readable yet: shown as "no still" */ }
  }))
  // Flagged first, then the busiest.
  return rooms.sort((a, b) => (Number(!!b.flagLevel) - Number(!!a.flagLevel)) || (b.viewers - a.viewers))
}

async function readFlags(): Promise<Flag[]> {
  const snap = await getDocs(query(collection(db, 'safetyFlags'), where('status', '==', 'open'), limit(100)))
  return snap.docs.map((d) => {
    const x = d.data()
    return {
      id: d.id, kind: String(x.kind ?? ''), level: String(x.level ?? ''), roomId: String(x.roomId ?? ''),
      uid: String(x.uid ?? ''), hostUid: String(x.hostUid ?? ''),
      words: Array.isArray(x.words) ? x.words.map(String) : [], createdAt: (x.createdAt ?? null) as Timestamp | null,
    }
  }).sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0))
}

const ago = (t: Timestamp | null) => {
  const ms = t?.toMillis?.() ?? 0
  if (!ms) return 'no still yet'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

export default function LiveWall() {
  const { crmUser, apiUser, loading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)
  const canModerate = !!crmUser && canAccess(crmUser, MODERATOR_ROLES)
  const canIntervene = INTERVENE_API_ROLES.some((r) => r === apiUser?.role)
  const [rooms, setRooms] = useState<WallRoom[] | null>(null)
  const [flags, setFlags] = useState<Flag[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [watching, setWatching] = useState<WallRoom | null>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [r, f] = await Promise.all([readWall(), readFlags().catch(() => [] as Flag[])])
      setRooms(r)
      setFlags(f)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The live rooms could not be read.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void load()
    const t = setInterval(() => void load(), REFRESH_SECONDS * 1000)
    return () => clearInterval(t)
  }, [allowed, load])

  if (loading) return <Loading />
  if (!allowed) return <Denied what="the live wall" />

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn()
      setNotice(done)
      void load()
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not work.')
    }
  }
  const askReason = (what: string) => {
    const r = window.prompt(`${what} — the reason (at least 6 characters, kept in the audit log):`) ?? ''
    return r.trim().length >= 6 ? r.trim() : ''
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Eye size={20} className="text-pink-400" /> Live wall</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">
            The newest still of every live room, refreshed every {REFRESH_SECONDS} seconds — flagged rooms first. Watching is
            silent. The AI check and automatic ending are the Owner&apos;s switches (App Config → Safety).
          </p>
        </div>
        <button onClick={() => void load()} disabled={busy}
          className="flex items-center gap-2 text-sm text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 disabled:opacity-60">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {notice && <p className="text-sm text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">{notice}</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className="grid lg:grid-cols-[1fr_320px] gap-5">
        <div>
          {rooms === null ? <Loading /> : rooms.length === 0 ? (
            <p className="text-slate-500 text-sm">Nobody is live right now.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {rooms.map((r) => (
                <div key={r.roomId} className={`rounded-xl overflow-hidden border ${r.flagLevel ? 'border-red-500 ring-2 ring-red-500/40' : 'border-slate-800'} bg-slate-900`}>
                  <div className="relative aspect-[9/16] bg-black">
                    {r.stillUrl
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={r.stillUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                      : <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600 text-xs gap-1"><ImageOff size={20} />no still yet</div>}
                    {r.flagLevel && (
                      <span className="absolute top-2 left-2 text-[10px] font-bold uppercase bg-red-600 text-white rounded px-1.5 py-0.5 flex items-center gap-1">
                        <ShieldAlert size={11} /> {r.flagLevel}
                      </span>
                    )}
                    <span className="absolute top-2 right-2 text-[10px] bg-black/60 text-white rounded px-1.5 py-0.5 inline-flex items-center gap-1">
                      <Users size={10} />{r.viewers}
                    </span>
                    <span className="absolute bottom-2 left-2 text-[10px] bg-black/60 text-slate-200 rounded px-1.5 py-0.5">{ago(r.stillAt)}</span>
                  </div>
                  <div className="p-2 space-y-1.5">
                    <p className="text-white text-xs font-medium truncate">{r.hostName || r.hostUid}</p>
                    {r.visionError && <p className="text-amber-400 text-[10px] truncate" title={r.visionError}>AI check: {r.visionError}</p>}
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => setWatching(r)} className="text-[11px] bg-pink-600 hover:bg-pink-500 text-white rounded px-2 py-1 inline-flex items-center gap-1"><Eye size={11} />Watch</button>
                      {canIntervene && (
                        <button onClick={() => { const why = askReason('End this live'); if (why) void act(() => live.end(r.roomId, why), 'The live was ended and the reason recorded.') }}
                          className="text-[11px] bg-slate-700 hover:bg-red-700 text-white rounded px-2 py-1 inline-flex items-center gap-1"><Square size={11} />End</button>
                      )}
                      {canModerate && (
                        <>
                          <button onClick={() => { const why = askReason('Warn the host'); if (why) void act(() => api.users.warn(r.hostUid, why), 'The host was warned.') }}
                            className="text-[11px] bg-amber-600/80 hover:bg-amber-500 text-white rounded px-2 py-1 inline-flex items-center gap-1"><AlertTriangle size={11} />Warn</button>
                          <button onClick={() => { const why = askReason('Ban the host'); if (why) void act(() => api.users.ban(r.hostUid, why), 'The host was banned. End the live too if it is still running.') }}
                            className="text-[11px] bg-red-700/80 hover:bg-red-600 text-white rounded px-2 py-1 inline-flex items-center gap-1"><Ban size={11} />Ban</button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside className="bg-slate-900 border border-slate-800 rounded-xl p-4 h-fit">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2"><ShieldAlert size={15} className="text-red-400" /> Open safety flags</h2>
          <p className="text-slate-500 text-xs mt-1">Stills the AI check flagged, and people the word screen silenced.</p>
          {flags.length === 0 ? (
            <p className="text-slate-500 text-sm mt-3">Nothing open.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {flags.map((f) => (
                <li key={f.id} className="border border-slate-800 rounded-lg p-2.5">
                  <p className="text-white text-xs font-medium">{f.kind.replace('_', ' ')} · {f.level}</p>
                  <p className="text-slate-400 text-[11px] break-all">{f.uid || f.hostUid} · room {f.roomId}</p>
                  {f.words.length > 0 && <p className="text-slate-500 text-[11px]">{f.words.length} flagged word{f.words.length === 1 ? '' : 's'}</p>}
                  <div className="flex gap-1 mt-1.5">
                    {canModerate && (
                      <button onClick={() => { const why = askReason('Ban this person'); if (why) void act(() => api.users.ban(f.uid || f.hostUid, why), 'Banned.') }}
                        className="text-[11px] bg-red-700/80 hover:bg-red-600 text-white rounded px-2 py-1 inline-flex items-center gap-1"><Ban size={11} />Ban</button>
                    )}
                    {canIntervene && (
                      <button onClick={() => void act(() => updateDoc(doc(db, 'safetyFlags', f.id), { status: 'closed', reviewedBy: crmUser?.uid ?? '', reviewedAt: serverTimestamp() }), 'Flag closed.')}
                        className="text-[11px] bg-slate-700 hover:bg-slate-600 text-white rounded px-2 py-1 inline-flex items-center gap-1"><CheckCircle2 size={11} />Close</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {watching && <LiveWatch roomId={watching.roomId} hostName={watching.hostName || watching.hostUid} onClose={() => setWatching(null)} />}
    </div>
  )
}

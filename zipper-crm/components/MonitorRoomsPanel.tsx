'use client'

/**
 * O12 (Owner, 5 Nov 2026) — "an agency can monitor its hosts and its sub-agencies; a sub-agency can monitor its
 * hosts." The rooms of the caller's own hosts that are open right now, each one a click from a silent watch (live) or
 * listen (party). The server works out the scope (`myMonitorRooms`) and refuses any other room (`monitorRoomToken`);
 * nobody in a room is told, listed or counted.
 */

import { useCallback, useEffect, useState } from 'react'
import { Eye, Headphones, Loader2, Lock, Radio, RefreshCw, Users } from 'lucide-react'
import LiveWatch from '@/components/LiveWatch'
import { myMonitorRooms, type MonitorRoom } from '@/lib/rooms'

const REFRESH_SECONDS = 30

export default function MonitorRoomsPanel({ heading = 'Live now — your hosts' }: { heading?: string }) {
  const [rooms, setRooms] = useState<MonitorRoom[] | null>(null)
  const [scope, setScope] = useState<'staff' | 'agency' | 'sub_agency' | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [watching, setWatching] = useState<MonitorRoom | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await myMonitorRooms()
      setRooms(res.rooms)
      setScope(res.as)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The open rooms could not be read.')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), REFRESH_SECONDS * 1000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2"><Radio size={16} className="text-pink-400" />{heading}</h2>
          <p className="text-slate-500 text-xs mt-1">
            {scope === 'agency'
              ? 'Your hosts and your sub-agencies\' hosts.'
              : scope === 'sub_agency' ? 'Your hosts.' : 'Every open room.'}{' '}
            Watching is silent: the host and the room are not told, and you are not listed or counted.
          </p>
        </div>
        <button onClick={() => void load()} disabled={busy}
          className="flex items-center gap-1.5 text-xs text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-md px-2.5 py-1.5 disabled:opacity-60">
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error ? (
        <p className="text-amber-300 text-sm">{error}</p>
      ) : rooms === null ? (
        <p className="text-slate-500 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Looking for open rooms…</p>
      ) : rooms.length === 0 ? (
        <p className="text-slate-500 text-sm">None of your hosts is live or in a party room right now.</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {rooms.map((r) => (
            <li key={`${r.kind}:${r.roomId}`} className="flex items-center gap-3 py-2.5">
              <span className={`text-[10px] font-semibold uppercase rounded px-1.5 py-0.5 ${r.kind === 'live' ? 'bg-red-500/20 text-red-300' : 'bg-violet-500/20 text-violet-300'}`}>
                {r.kind === 'live' ? 'Live' : 'Party'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-white text-sm truncate flex items-center gap-1.5">
                  {r.private && <Lock size={12} className="text-amber-400" aria-label="Private (PIN)" />}
                  {r.title || (r.kind === 'live' ? 'Live' : 'Party room')}
                </p>
                <p className="text-slate-500 text-xs truncate">{r.hostName || r.hostUid}</p>
              </div>
              <span className="text-slate-400 text-xs inline-flex items-center gap-1"><Users size={12} />{r.audience}</span>
              <button onClick={() => setWatching(r)}
                className="flex items-center gap-1.5 text-xs bg-pink-600 hover:bg-pink-500 text-white rounded-md px-2.5 py-1.5">
                {r.kind === 'live' ? <Eye size={13} /> : <Headphones size={13} />}{r.kind === 'live' ? 'Watch' : 'Listen'}
              </button>
            </li>
          ))}
        </ul>
      )}

      {watching && (
        <LiveWatch kind={watching.kind} roomId={watching.roomId}
          hostName={`${watching.title || (watching.kind === 'live' ? 'Live' : 'Party room')} — ${watching.hostName || watching.hostUid}`}
          onClose={() => setWatching(null)} />
      )}
    </div>
  )
}

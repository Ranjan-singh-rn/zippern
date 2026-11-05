'use client'

/**
 * Party monitor — listen silently, and act. O12 (Owner, 5 Nov 2026).
 *
 *   "In the CRM also, we have live monitoring, party monitoring. When it is monitoring, don't let those persons who
 *    are sitting in the party know … unless the official itself joined that party room through the application."
 *
 * The party twin of `/live`. Rooms are real-time app state, read from Firestore directly (`partyRooms` where
 * `isActive`); every ACTION goes through the API so it lands in the audit log against a named person: warning and
 * banning the host through `api.users.*`, closing the room through `live.endParty`. **Nothing on this page writes to
 * Firestore.**
 *
 * Listening is silent: `monitorRoomToken` writes no listener row, no seat, no join message and no arrival, and the
 * room's channel is live-broadcasting, where an audience member is invisible to everyone in it. A PIN-locked room
 * opens for a monitor without the PIN. Each listen is recorded on the server (who, which room, when) — never in the
 * room.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Ban, Headphones, Loader2, Lock, MicOff, RefreshCw, ShieldAlert, Users, X } from 'lucide-react'
import { getActivePartyRooms, type PartyRoomRow } from '@/lib/rooms'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { live } from '@/lib/apiPartners'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import LiveWatch from '@/components/LiveWatch'

/** Who may open the page — the same people who may open `/live`. */
const PAGE_ROLES: CrmRole[] = ['app_admin', 'app_member', 'ops_admin', 'ops_member', 'tech_admin', 'tech_member', 'support_admin']
/** Warning and banning a host. */
const MODERATOR_ROLES: CrmRole[] = ['app_admin', 'app_member', 'ops_admin', 'ops_member']
/** Closing a room in front of everyone in it: Ops or an owner (the API decides; this only saves a round trip). */
const INTERVENE_API_ROLES = ['owner', 'ops_admin', 'ops_member'] as const
const MIN_REASON = 6
const REFRESH_SECONDS = 30

type Action = 'warn' | 'ban' | 'end'

const ACTION: Record<Action, { title: (r: PartyRoomRow) => string; blurb: string; label: string; tone: 'danger' | 'warning' }> = {
  warn: {
    title: (r) => `Warn ${r.hostName || 'this host'}`,
    blurb: 'A formal warning on the host\'s account, in their history. The room keeps running. Audited with your name.',
    label: 'Warn host', tone: 'warning',
  },
  ban: {
    title: (r) => `Ban ${r.hostName || 'this host'}`,
    blurb: 'The account is banned at once. This does not close the room by itself — close it too if it must stop now. Audited with your name.',
    label: 'Ban host', tone: 'danger',
  },
  end: {
    title: (r) => `Close ${r.title || 'this room'}`,
    blurb: 'The room is closed and its seats cleared; every phone in it leaves when it reads the flag. The host\'s account is untouched — closing a room is not a ban. Audited with your name.',
    label: 'Close room', tone: 'danger',
  },
}

export default function PartyMonitor() {
  const { crmUser, apiUser, loading: authLoading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)
  const canModerate = !!crmUser && canAccess(crmUser, MODERATOR_ROLES)
  const canIntervene = INTERVENE_API_ROLES.some((r) => r === apiUser?.role)

  const [rooms, setRooms] = useState<PartyRoomRow[] | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [listening, setListening] = useState<PartyRoomRow | null>(null)
  const [acting, setActing] = useState<{ room: PartyRoomRow; action: Action } | null>(null)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setRefreshing(true)
    try {
      setRooms(await getActivePartyRooms())
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The party rooms could not be read.')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!allowed) return
    void load()
    const t = setInterval(() => void load(), REFRESH_SECONDS * 1000)
    return () => clearInterval(t)
  }, [allowed, load])

  if (authLoading) return <Loading />
  if (!allowed) return <Denied what="party monitoring" />

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Headphones size={20} className="text-pink-400" /> Party rooms</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Listen to any room silently — nobody in it is told, listed or counted, and a PIN-locked room opens without
            the PIN. Every listen is recorded on the server. Refreshes every {REFRESH_SECONDS} seconds.
          </p>
        </div>
        <button onClick={() => void load()} disabled={refreshing}
          className="flex items-center gap-2 text-sm text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg px-3 py-2 disabled:opacity-60">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {notice && (
        <div className="flex items-start gap-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          <p className="text-emerald-300 text-sm flex-1">{notice}</p>
          <button onClick={() => setNotice('')} className="text-emerald-400" aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}

      {error ? <ErrorState message={error} /> : rooms === null ? <Loading /> : rooms.length === 0 ? (
        <Empty title="No party room is open right now" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900 text-slate-400 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-3">Room</th>
                <th className="text-left px-4 py-3">Host</th>
                <th className="text-right px-4 py-3">On seats</th>
                <th className="text-right px-4 py-3">Listening</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((r) => (
                <tr key={r.roomId} className="border-t border-slate-800">
                  <td className="px-4 py-3 text-white">
                    <div className="flex items-center gap-2">
                      {r.visibility === 'private' && <Lock size={13} className="text-amber-400" aria-label="Private (PIN)" />}
                      <span className="truncate max-w-[16rem]">{r.title || r.roomId}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{r.hostName || r.hostUid}</td>
                  <td className="px-4 py-3 text-right text-slate-300">{r.occupantCount}</td>
                  <td className="px-4 py-3 text-right text-slate-300"><span className="inline-flex items-center gap-1"><Users size={12} />{r.listenerCount}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setListening(r)}
                        className="flex items-center gap-1.5 text-xs bg-pink-600 hover:bg-pink-500 text-white rounded-md px-2.5 py-1.5">
                        <Headphones size={13} /> Listen
                      </button>
                      {canModerate && (
                        <>
                          <button onClick={() => setActing({ room: r, action: 'warn' })}
                            className="flex items-center gap-1.5 text-xs bg-amber-600/80 hover:bg-amber-500 text-white rounded-md px-2.5 py-1.5">
                            <ShieldAlert size={13} /> Warn
                          </button>
                          <button onClick={() => setActing({ room: r, action: 'ban' })}
                            className="flex items-center gap-1.5 text-xs bg-red-700/80 hover:bg-red-600 text-white rounded-md px-2.5 py-1.5">
                            <Ban size={13} /> Ban
                          </button>
                        </>
                      )}
                      <button onClick={() => setActing({ room: r, action: 'end' })} disabled={!canIntervene}
                        title={canIntervene ? '' : 'Closing a room is for Ops and the Owner.'}
                        className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-red-700 text-white rounded-md px-2.5 py-1.5 disabled:opacity-40 disabled:hover:bg-slate-700">
                        <MicOff size={13} /> Close
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {listening && (
        <LiveWatch kind="party" roomId={listening.roomId}
          hostName={`${listening.title || 'Party room'} — ${listening.hostName || listening.hostUid}`}
          onClose={() => setListening(null)} />
      )}

      {acting && (
        <ReasonModal
          title={ACTION[acting.action].title(acting.room)}
          blurb={ACTION[acting.action].blurb}
          confirmLabel={ACTION[acting.action].label}
          tone={ACTION[acting.action].tone}
          onCancel={() => setActing(null)}
          onConfirm={async (reason) => {
            const { room, action } = acting
            if (action === 'ban') await api.users.ban(room.hostUid, reason)
            if (action === 'warn') await api.users.warn(room.hostUid, reason)
            if (action === 'end') {
              const res = await live.endParty(room.roomId, reason)
              setNotice(res.note)
            } else {
              setNotice(`${ACTION[action].label}: done, and recorded with your name.`)
            }
            setActing(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function ReasonModal({
  title, blurb, confirmLabel, tone, onCancel, onConfirm,
}: {
  title: string
  blurb: string
  confirmLabel: string
  tone: 'danger' | 'warning'
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
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not work.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <h2 className="text-white font-semibold">{title}</h2>
        <p className="text-slate-400 text-sm mt-1 leading-relaxed">{blurb}</p>
        <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mt-4 mb-1.5">Reason (required)</label>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus disabled={busy}
          placeholder="What happened, in enough detail that this makes sense in six months…"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 disabled:opacity-60" />
        {tooShort && reason.length > 0 && <p className="text-slate-500 text-xs mt-1">At least {MIN_REASON} characters.</p>}
        {err && (
          <div className="flex items-start gap-2 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
            <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-300 text-sm">{err}</p>
          </div>
        )}
        <div className="flex gap-3 mt-5">
          <button onClick={onCancel} disabled={busy}
            className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy || tooShort}
            className={`flex-1 flex items-center justify-center gap-2 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm ${tone === 'danger' ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'}`}>
            {busy && <Loader2 size={15} className="animate-spin" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

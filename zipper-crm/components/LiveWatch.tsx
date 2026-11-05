'use client'

/**
 * Watch a live stream from the CRM.
 *
 * ── WHY THIS DID NOT EXIST, AND WHAT THAT COST ───────────────────────────────
 *
 * `/live` listed the rooms, the viewer counts, the gift totals and the flags,
 * and gave a moderator Warn, Ban, Mute and End — every control you need to act
 * on a stream, and no way to see the stream. So the one question moderation
 * actually asks, "what is this person broadcasting", could not be answered from
 * the tool built to answer it. The honest workflow was: open the Android app on
 * a phone, find the same host, and decide there.
 *
 * The reason was mundane: the CRM had no Agora SDK. The token now comes from the
 * server's own monitoring callable, `monitorRoomToken` (O12, 5 Nov 2026): a
 * SUBSCRIBER token for the monitor's OWN uid (joined with exactly that uid —
 * the app's `generateAgoraToken` signs for a derived uid and Agora refuses any
 * other, 0 included), for staff on any room and for an agency or sub-agency on
 * its own hosts' rooms. A host's kick list or a private room's PIN does not stop
 * a monitor; nothing about the room changes.
 *
 * ── LOADED FROM AGORA'S CDN, DELIBERATELY ────────────────────────────────────
 *
 * Not an npm dependency. The CRM ships as a static export, the SDK is ~500 KB
 * that every other page would pay for in its bundle graph, and moderation is a
 * page a handful of staff open. A `<script>` loaded on first use costs nothing
 * to the other eighty-five routes and is pinned to an exact version, so it
 * cannot move under us.
 *
 * ── WATCHING IS INVISIBLE, AND THAT IS THE POINT ─────────────────────────────
 *
 * O12 (Owner, 5 Nov 2026): "don't let those persons who are sitting in the party
 * know they are being monitored". The token comes from `monitorRoomToken`, which
 * writes NOTHING in the room — no `viewers/{uid}` row, no party listener row, no
 * join comment, no seat — and every room uses Agora's live-broadcasting profile,
 * where an audience member is invisible to everyone else in the channel. So a
 * moderator does not appear in a viewer list, a listener list or a count, and no
 * arrival is announced. A host who can see when they are being watched behaves
 * differently while being watched, which would make the tool useless.
 *
 * It is still recorded: every token is a `monitorSessions` row on the server
 * (who, which room, whose room, when), and every ACTION taken from these pages
 * goes through the API into the audit trail against a named person.
 *
 * The same component watches a PARTY room: every seat that publishes is shown
 * (video when the seat has its camera on, a voice tile when not) and every voice
 * plays. Agencies and sub-agencies use it for their own hosts' rooms
 * (`/agency-dashboard`); the server decides which rooms each may open.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Mic, VideoOff, X } from 'lucide-react'
import { httpsCallable } from 'firebase/functions'
import { crmFunctions } from '@/lib/firebase'

/**
 * Pinned. An SDK that silently moves to a new major version behind a moderation
 * tool is a tool that stops working on a day nobody changed anything.
 */
const AGORA_SDK_URL = 'https://download.agora.io/sdk/release/AgoraRTC_N-4.20.2.js'

/** The subset of the Agora web client this component uses. */
interface AgoraUser {
  uid: number | string
  hasVideo?: boolean
  hasAudio?: boolean
  videoTrack?: { play: (el: HTMLElement) => void; stop: () => void }
  audioTrack?: { play: () => void; stop: () => void }
}
interface AgoraClient {
  join: (appId: string, channel: string, token: string | null, uid?: number | null) => Promise<void>
  leave: () => Promise<void>
  subscribe: (user: AgoraUser, kind: 'video' | 'audio') => Promise<void>
  renewToken: (token: string) => Promise<void>
  on: (evt: string, cb: (...args: never[]) => void) => void
  removeAllListeners: () => void
  remoteUsers: AgoraUser[]
}
interface AgoraSDK {
  createClient: (cfg: { mode: string; codec: string }) => AgoraClient
  setLogLevel: (level: number) => void
}

declare global {
  interface Window { AgoraRTC?: AgoraSDK }
}

/** What `monitorRoomToken` answers: a SUBSCRIBER token for exactly this monitor's own uid. */
interface MonitorToken {
  token: string
  appId: string
  uid: number
  channelName: string
  role: 'subscriber'
  expiresAt: number
  as: 'staff' | 'agency' | 'sub_agency'
}

export type WatchKind = 'live' | 'party'

/** Ask the server for a silent watch of this room. It refuses a room the caller may not monitor. */
export async function monitorToken(kind: WatchKind, roomId: string): Promise<MonitorToken> {
  const call = httpsCallable<{ kind: WatchKind; roomId: string }, MonitorToken>(crmFunctions(), 'monitorRoomToken')
  const res = await call({ kind, roomId })
  if (!res.data?.appId) throw new Error('The server did not return an Agora app id.')
  return res.data
}

/** Load the SDK once per page, and hand every later caller the same promise. */
let sdkPromise: Promise<AgoraSDK> | null = null

function loadAgora(): Promise<AgoraSDK> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.AgoraRTC) return Promise.resolve(window.AgoraRTC)
  if (sdkPromise) return sdkPromise

  sdkPromise = new Promise<AgoraSDK>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = AGORA_SDK_URL
    script.async = true
    script.onload = () => {
      if (window.AgoraRTC) resolve(window.AgoraRTC)
      else reject(new Error('The Agora SDK loaded but did not register itself.'))
    }
    script.onerror = () => {
      sdkPromise = null // let a retry try again
      reject(new Error(
        'The video SDK could not be downloaded. Check the network, or whether ' +
        'download.agora.io is reachable from here.',
      ))
    }
    document.head.appendChild(script)
  })
  return sdkPromise
}

/** One publisher in a party room: its uid is its seat number. */
interface Speaker { uid: string; video: boolean }

/** A seat's video, attached to its own element once React has drawn it. */
function SeatVideo({ user }: { user: AgoraUser }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (ref.current && user.videoTrack) user.videoTrack.play(ref.current)
  }, [user, user.videoTrack])
  return <div ref={ref} className="absolute inset-0 [&>video]:object-cover" />
}

export default function LiveWatch({
  roomId,
  hostName,
  kind = 'live',
  onClose,
}: {
  /** The room id — a live room's is also its Agora channel; a party room's channel is `party_<id>`. */
  roomId: string
  hostName: string
  kind?: WatchKind
  onClose: () => void
}) {
  const videoRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<AgoraClient | null>(null)
  const usersRef = useRef<Map<string, AgoraUser>>(new Map())
  const [status, setStatus] = useState<'loading' | 'watching' | 'waiting' | 'failed'>('loading')
  const [error, setError] = useState('')
  const [speakers, setSpeakers] = useState<Speaker[]>([])

  const stop = useCallback(async () => {
    const client = clientRef.current
    clientRef.current = null
    usersRef.current.clear()
    if (!client) return
    try {
      client.remoteUsers.forEach((u) => {
        u.videoTrack?.stop()
        u.audioTrack?.stop()
      })
      client.removeAllListeners()
      await client.leave()
    } catch {
      /* Leaving a channel we may never have joined is not worth reporting. */
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refreshSpeakers = () => {
      const list = Array.from(usersRef.current.values()).map((u) => ({ uid: String(u.uid), video: !!u.videoTrack }))
      list.sort((a, b) => Number(a.uid) - Number(b.uid))
      setSpeakers(list)
    }

    async function start() {
      try {
        const AgoraRTC = await loadAgora()
        if (cancelled) return
        AgoraRTC.setLogLevel(3) // warnings and errors only

        // A subscriber token for this monitor's own uid — the server decides, and writes nothing in the room.
        const t = await monitorToken(kind, roomId)
        if (cancelled) return

        const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' })
        clientRef.current = client

        client.on('user-published', (async (user: AgoraUser, what: 'video' | 'audio') => {
          await client.subscribe(user, what)
          usersRef.current.set(String(user.uid), user)
          if (what === 'audio') user.audioTrack?.play()
          if (kind === 'live') {
            if (what === 'video' && videoRef.current) {
              user.videoTrack?.play(videoRef.current)
              setStatus('watching')
            }
          } else {
            refreshSpeakers()
            setStatus('watching')
          }
        }) as never)

        client.on('user-unpublished', ((user: AgoraUser, what: 'video' | 'audio') => {
          if (kind === 'live') {
            if (what === 'video') setStatus('waiting')
          } else {
            refreshSpeakers()
          }
        }) as never)

        client.on('user-left', ((user: AgoraUser) => {
          usersRef.current.delete(String(user.uid))
          if (kind === 'party') refreshSpeakers()
        }) as never)

        // Keep watching past the token's hour: ask again, silently, before it lapses.
        client.on('token-privilege-will-expire', (async () => {
          try {
            const next = await monitorToken(kind, roomId)
            await clientRef.current?.renewToken(next.token)
          } catch {
            /* The room may have ended; the next disconnect says so. */
          }
        }) as never)

        // Join with the uid the token was signed for — Agora refuses any other (0 included).
        await client.join(t.appId, t.channelName, t.token, t.uid)
        if (cancelled) { await stop(); return }

        // Joined, but the host may not have published yet — or may have gone
        // off camera. Those are different from a failure and say so.
        setStatus((s) => (s === 'watching' ? s : 'waiting'))
      } catch (e) {
        if (cancelled) return
        setStatus('failed')
        const msg = e instanceof Error ? e.message : ''
        setError(msg || (kind === 'live' ? 'The stream could not be opened.' : 'The room could not be opened.'))
      }
    }

    start()
    return () => {
      cancelled = true
      void stop()
    }
  }, [roomId, kind, stop])

  const live = kind === 'live'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold truncate">{hostName || roomId}</h2>
            <p className="text-slate-500 text-xs mt-0.5">
              {live
                ? 'You are watching silently — the host is not told, and you are not counted or listed among the viewers.'
                : 'You are listening silently — nobody in the room is told, and you are not listed, counted or announced.'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="relative bg-black aspect-video">
          {live ? (
            <div ref={videoRef} className="absolute inset-0 [&>video]:object-contain" />
          ) : (
            <div className="absolute inset-0 grid grid-cols-3 gap-1 p-1 auto-rows-fr">
              {speakers.map((sp) => {
                const user = usersRef.current.get(sp.uid)
                return (
                  <div key={sp.uid} className="relative rounded-md overflow-hidden bg-slate-800 flex items-center justify-center">
                    {sp.video && user ? <SeatVideo user={user} /> : <Mic size={20} className="text-pink-400" />}
                    <span className="absolute left-1 bottom-1 text-[10px] text-white bg-black/60 rounded px-1">
                      Seat {sp.uid}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {(live ? status !== 'watching' : status !== 'watching' || speakers.length === 0) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              {status === 'loading' && (
                <>
                  <Loader2 size={24} className="animate-spin text-pink-500" />
                  <p className="text-slate-400 text-sm">{live ? 'Connecting to the stream…' : 'Connecting to the room…'}</p>
                </>
              )}
              {(status === 'waiting' || (status === 'watching' && !live)) && (
                <>
                  <VideoOff size={24} className="text-slate-600" />
                  <p className="text-slate-400 text-sm">
                    {live ? 'Connected, but the host is not sending video right now.' : 'Connected. Nobody on a seat is speaking right now.'}
                  </p>
                  <p className="text-slate-600 text-xs">
                    {live
                      ? 'They may have covered the camera or dropped their connection. The room is still open.'
                      : 'Voices and cameras appear here the moment a seat publishes.'}
                  </p>
                </>
              )}
              {status === 'failed' && (
                <>
                  <AlertTriangle size={24} className="text-yellow-400" />
                  <p className="text-yellow-200 text-sm">{error}</p>
                  <p className="text-slate-600 text-xs">
                    This is about the media, not about the host. Every control
                    on the page still works.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800">
          <p className="text-slate-600 text-xs">
            Audio plays through this tab. Close the window to stop — leaving the
            page does the same. Your watch is recorded on the server (who, which
            room, when); the room never sees it.
          </p>
        </div>
      </div>
    </div>
  )
}

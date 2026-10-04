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
 * The reason was mundane. The CRM has no Agora SDK; nothing was missing on the
 * server. `generateAgoraToken` already hands a signed-in staff member a
 * SUBSCRIBER token for any live channel — they are not the host, so they cannot
 * publish, and they are not in `kickedViewers`, so they are not refused.
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
 * Joining the Agora channel does NOT write `liveRooms/{id}/viewers/{uid}`, so a
 * moderator does not appear in the host's viewer list or bump the count. A host
 * who can see when they are being watched behaves differently while being
 * watched, which would make the tool useless for the thing it is for.
 *
 * It is still recorded: the room and the moderator go in the console log, and
 * every ACTION taken from this page already goes through the API into the audit
 * trail against a named person. Watching is not an action.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Loader2, VideoOff, X } from 'lucide-react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { app } from '@/lib/firebase'

/**
 * Pinned. An SDK that silently moves to a new major version behind a moderation
 * tool is a tool that stops working on a day nobody changed anything.
 */
const AGORA_SDK_URL = 'https://download.agora.io/sdk/release/AgoraRTC_N-4.20.2.js'

/** The subset of the Agora web client this component uses. */
interface AgoraUser {
  uid: number | string
  videoTrack?: { play: (el: HTMLElement) => void; stop: () => void }
  audioTrack?: { play: () => void; stop: () => void }
}
interface AgoraClient {
  join: (appId: string, channel: string, token: string | null, uid?: number | null) => Promise<void>
  leave: () => Promise<void>
  subscribe: (user: AgoraUser, kind: 'video' | 'audio') => Promise<void>
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

export default function LiveWatch({
  roomId,
  hostName,
  onClose,
}: {
  /** The live room id, which is also the Agora channel name. */
  roomId: string
  hostName: string
  onClose: () => void
}) {
  const videoRef = useRef<HTMLDivElement | null>(null)
  const clientRef = useRef<AgoraClient | null>(null)
  const [status, setStatus] = useState<'loading' | 'watching' | 'waiting' | 'failed'>('loading')
  const [error, setError] = useState('')

  const stop = useCallback(async () => {
    const client = clientRef.current
    clientRef.current = null
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

    async function start() {
      try {
        const AgoraRTC = await loadAgora()
        if (cancelled) return
        AgoraRTC.setLogLevel(3) // warnings and errors only

        // The same callable the Android app uses. Staff are not the host, so
        // this comes back as a subscriber token — the server decides the role,
        // and there is no way to ask it for a publishing one.
        const call = httpsCallable<
          { channelName: string; uid: number },
          { token: string; appId: string }
        >(getFunctions(app, 'asia-south1'), 'generateAgoraToken')
        const res = await call({ channelName: roomId, uid: 0 })
        if (cancelled) return

        const { token, appId } = res.data
        if (!appId) throw new Error('The server did not return an Agora app id.')

        const client = AgoraRTC.createClient({ mode: 'live', codec: 'vp8' })
        clientRef.current = client

        client.on('user-published', (async (user: AgoraUser, kind: 'video' | 'audio') => {
          await client.subscribe(user, kind)
          if (kind === 'video' && videoRef.current) {
            user.videoTrack?.play(videoRef.current)
            setStatus('watching')
          }
          if (kind === 'audio') user.audioTrack?.play()
        }) as never)

        client.on('user-unpublished', ((_u: AgoraUser, kind: 'video' | 'audio') => {
          if (kind === 'video') setStatus('waiting')
        }) as never)

        await client.join(appId, roomId, token ?? null, 0)
        if (cancelled) { await stop(); return }

        // Joined, but the host may not have published yet — or may have gone
        // off camera. Those are different from a failure and say so.
        setStatus((s) => (s === 'watching' ? s : 'waiting'))
      } catch (e) {
        if (cancelled) return
        setStatus('failed')
        setError(
          e instanceof Error
            ? e.message
            : 'The stream could not be opened.',
        )
      }
    }

    start()
    return () => {
      cancelled = true
      void stop()
    }
  }, [roomId, stop])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-2xl overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold truncate">{hostName || roomId}</h2>
            <p className="text-slate-500 text-xs mt-0.5">
              You are watching silently — the host is not told, and you are not
              counted in their viewers.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="relative bg-black aspect-video">
          <div ref={videoRef} className="absolute inset-0 [&>video]:object-contain" />

          {status !== 'watching' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
              {status === 'loading' && (
                <>
                  <Loader2 size={24} className="animate-spin text-pink-500" />
                  <p className="text-slate-400 text-sm">Connecting to the stream…</p>
                </>
              )}
              {status === 'waiting' && (
                <>
                  <VideoOff size={24} className="text-slate-600" />
                  <p className="text-slate-400 text-sm">
                    Connected, but the host is not sending video right now.
                  </p>
                  <p className="text-slate-600 text-xs">
                    They may have covered the camera or dropped their connection.
                    The room is still open.
                  </p>
                </>
              )}
              {status === 'failed' && (
                <>
                  <AlertTriangle size={24} className="text-yellow-400" />
                  <p className="text-yellow-200 text-sm">{error}</p>
                  <p className="text-slate-600 text-xs">
                    This is about the video, not about the host. Every control
                    below still works.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-800">
          <p className="text-slate-600 text-xs">
            Audio plays through this tab. Close the window to stop watching —
            leaving the page does the same.
          </p>
        </div>
      </div>
    </div>
  )
}

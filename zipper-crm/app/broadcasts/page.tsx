'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getBroadcasts, sendBroadcast, BroadcastRecord } from '@/lib/firestore'
import { Megaphone, Send, Loader2, Check, AlertTriangle, X, Clock, Shield, Mail } from 'lucide-react'
import Link from 'next/link'
import type { Timestamp } from 'firebase/firestore'

function formatDate(ts: Timestamp | null) {
  if (!ts) return '—'
  try { return new Date(ts.toMillis()).toLocaleString('en-IN') } catch { return '—' }
}

type Msg = { type: 'success' | 'error'; text: string }

const BROADCAST_ROLES = ['superadmin', 'marketing_admin', 'marketing_member'] as const

export default function BroadcastsPage() {
  const { crmUser } = useAuth()
  const canSend = canAccess(crmUser, [...BROADCAST_ROLES])
  const [broadcasts, setBroadcasts] = useState<BroadcastRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [sending, setSending] = useState(false)
  // The app renders a headline above the body and has always read `title` for
  // it. There was no field for one here, so it read an empty string.
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [senderName, setSenderName] = useState('Zipper Team')
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setBroadcasts(await getBroadcasts())
    } catch {
      setMsg({ type: 'error', text: 'Failed to load broadcasts.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canSend) return
    load()
  }, [load, canSend])

  if (!canSend) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Shield size={48} className="text-slate-600" />
        <h1 className="text-white text-2xl font-bold">Access Denied</h1>
        <p className="text-slate-400 text-sm">Only Marketing team members can send broadcasts.</p>
      </div>
    )
  }

  async function handleSend() {
    if (!title.trim() || !message.trim()) return
    if (!confirm) { setConfirm(true); return }
    setSending(true)
    setConfirm(false)
    try {
      await sendBroadcast(title.trim(), message.trim(), senderName.trim() || 'Zipper Team')
      setMsg({ type: 'success', text: 'Broadcast sent to all users!' })
      setTitle('')
      setMessage('')
      await load()
    } catch {
      setMsg({ type: 'error', text: 'Failed to send broadcast.' })
    } finally {
      setSending(false)
    }
  }

  const charCount = message.length
  const charMax = 500

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-2">
          <Megaphone size={28} className="text-yellow-400" />
          Broadcasts
        </h1>
        <p className="text-slate-400 mt-1">Send announcements to all Zipper users in-app</p>
      </div>

      {/*
        In-app and email are two different things that both mean "tell
        everybody", and the difference matters enough to say on the screen: this
        page writes a Firestore document the Android app reads, and reaches
        whoever opens the app. The composer reaches an inbox, goes out through
        the business API's delivery layer, and leaves a row per recipient in the
        delivery log. Neither replaces the other.
      */}
      <div className="mb-6 flex flex-wrap items-center gap-3 bg-slate-800/40 border border-slate-700 rounded-xl px-4 py-3">
        <Megaphone size={16} className="text-yellow-400 shrink-0" />
        <p className="text-slate-400 text-sm flex-1 min-w-[16rem]">
          This sends an <strong className="text-slate-300">in-app announcement</strong>.
          To send <strong className="text-slate-300">email</strong> — with a subject,
          attachments and a choice of audience — use the composer.
        </p>
        <Link
          href="/broadcasts/email"
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white rounded-lg px-4 py-2 text-sm font-semibold transition shrink-0"
        >
          <Mail size={15} /> Email composer
        </Link>
      </div>

      {/* Message */}
      {msg && (
        <div className={`mb-5 flex items-center justify-between gap-2 px-4 py-3 rounded-xl text-sm border ${
          msg.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          <div className="flex items-center gap-2">
            {msg.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}
            {msg.text}
          </div>
          <button onClick={() => setMsg(null)}><X size={14} /></button>
        </div>
      )}

      {/* Compose Box */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-white mb-4">New Broadcast</h2>

        <div className="space-y-4">
          {/* Sender name */}
          <div>
            <label className="block text-slate-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
              Sender Name
            </label>
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="e.g. Zipper Team"
              className="w-full max-w-xs bg-slate-700 border border-slate-600 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-yellow-500 transition"
            />
          </div>

          {/* Title — the headline the app shows above the body */}
          <div>
            <label className="block text-slate-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
              Title
            </label>
            <input
              type="text"
              value={title}
              maxLength={80}
              onChange={(e) => { setTitle(e.target.value); setConfirm(false) }}
              placeholder="e.g. Diwali event starts tonight"
              className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-yellow-500 transition"
            />
            <p className="text-slate-500 text-xs mt-1">
              Shown in bold above the message in the app&rsquo;s Broadcasts tab.
            </p>
          </div>

          {/* Message */}
          <div>
            <label className="block text-slate-400 text-xs font-semibold uppercase tracking-wide mb-1.5">
              Message
            </label>
            <textarea
              rows={4}
              value={message}
              maxLength={charMax}
              onChange={(e) => { setMessage(e.target.value); setConfirm(false) }}
              placeholder="Type your announcement here..."
              className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-yellow-500 transition resize-none"
            />
            <p className={`text-xs mt-1 text-right ${charCount > charMax * 0.9 ? 'text-yellow-400' : 'text-slate-500'}`}>
              {charCount}/{charMax}
            </p>
          </div>

          {/* Warning before send */}
          {confirm && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
              <p className="text-yellow-300 font-semibold text-sm mb-1">⚠️ Confirm Broadcast</p>
              <p className="text-slate-300 text-sm">
                This will send a notification to <strong>all users</strong> on the platform. Click Send again to confirm.
              </p>
            </div>
          )}

          <button
            onClick={handleSend}
            disabled={sending || !title.trim() || !message.trim()}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition disabled:opacity-50 ${
              confirm
                ? 'bg-yellow-500 hover:bg-yellow-400 text-black'
                : 'bg-pink-500 hover:bg-pink-600 text-white'
            }`}
          >
            {sending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
            {confirm ? 'Confirm & Send to All Users' : 'Send Broadcast'}
          </button>
        </div>
      </div>

      {/* History */}
      <div>
        <h2 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
          <Clock size={18} className="text-slate-400" />
          Broadcast History
        </h2>

        {loading ? (
          <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : broadcasts.length === 0 ? (
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-10 text-center">
            <Megaphone size={36} className="text-slate-600 mx-auto mb-3" />
            <p className="text-slate-400">No broadcasts sent yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {broadcasts.map((bc) => (
              <div key={bc.id} className="bg-slate-800 border border-slate-700 rounded-xl px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-xs font-bold flex-shrink-0">
                      {bc.senderName?.[0]?.toUpperCase() ?? 'Z'}
                    </div>
                    <div>
                      <p className="text-white font-semibold text-sm">{bc.senderName}</p>
                      <p className="text-slate-500 text-xs">{formatDate(bc.createdAt)}</p>
                    </div>
                  </div>
                  <span className="text-xs text-slate-500 font-mono">{bc.id.slice(0, 8)}…</span>
                </div>
                {bc.title ? (
                  <p className="text-white font-semibold text-sm mb-1">{bc.title}</p>
                ) : (
                  // No title means this predates the field-name fix. Say so
                  // rather than leaving a gap: it is also the marker for the
                  // broadcasts that reached the app as blank cards.
                  <p className="text-amber-400/70 text-xs mb-1">
                    Sent before this page had a title field — it reached the app with no
                    headline.
                  </p>
                )}
                <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">
                  {bc.body}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

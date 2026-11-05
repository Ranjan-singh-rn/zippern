'use client'

/**
 * WorkAlerts (6 Nov 2026, Owner: "give a toast or notification — otherwise no
 * one gets it"). Staff were never told that something new was waiting: a seller
 * could submit a coin purchase (UTR + screenshot) and nobody looked until they
 * happened to open the right page.
 *
 * Every 60 s (and when the tab regains focus) this reads GET /cards/inbox — the
 * backend's own "what is waiting on you, across every board" count, already
 * scoped to the caller's role (to_verify for Finance/Ops, to_sign for Owners).
 * When the number goes UP it shows a toast with a link, raises a desktop
 * notification if the browser allows it, and keeps "(n)" in the tab title
 * while anything is waiting. Read-only: it changes nothing.
 */

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, X } from 'lucide-react'
import api, { type Inbox } from '@/lib/api'

const POLL_MS = 60_000

export function waitingTotal(i: Inbox | null | undefined): number {
  if (!i) return 0
  return Math.max(0, (i.to_verify || 0) + (i.to_sign || 0))
}

/** The toast text for a rise from `before` to `now`; '' when nothing new. */
export function riseMessage(before: Inbox | null, now: Inbox): string {
  const parts: string[] = []
  const dv = (now.to_verify || 0) - (before?.to_verify || 0)
  const ds = (now.to_sign || 0) - (before?.to_sign || 0)
  if (dv > 0) parts.push(`${dv} new request${dv === 1 ? '' : 's'} to check (coin purchases, recharges, payouts…)`)
  if (ds > 0) parts.push(`${ds} card${ds === 1 ? '' : 's'} waiting for your signature`)
  return parts.join(' · ')
}

export default function WorkAlerts({ enabled, owner = false }: { enabled: boolean; owner?: boolean }) {
  const last = useRef<Inbox | null>(null)
  const [toast, setToast] = useState<{ text: string; href: string } | null>(null)
  const baseTitle = useRef<string>('')

  const poll = useCallback(async () => {
    let now: Inbox
    try { now = await api.cards.inbox() } catch { return }
    // Owners sign, so the server counts only what awaits their signature. The
    // Owner also wants to hear the moment a seller submits (UTR + screenshot),
    // before Finance has checked it — so count the new cards too.
    if (owner && !(now.to_verify > 0)) {
      try {
        const [a, b] = await Promise.all([api.cards.list('requested', 500), api.cards.list('under_review', 500)])
        now = { ...now, to_verify: a.length + b.length }
      } catch { /* the inbox alone still works */ }
    }
    const before = last.current
    last.current = now
    const total = waitingTotal(now)
    if (typeof document !== 'undefined') {
      if (!baseTitle.current) baseTitle.current = document.title.replace(/^\(\d+\+?\)\s*/, '')
      document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${baseTitle.current}` : baseTitle.current
    }
    // First read only sets the baseline, except: anything already waiting is
    // announced once, so a person who signs in learns about it immediately.
    const text = before ? riseMessage(before, now) : (total > 0 ? `${total} item${total === 1 ? '' : 's'} waiting for you` : '')
    if (!text) return
    const href = (now.to_sign || 0) > (before?.to_sign || 0) ? '/board' : '/coin-purchases'
    setToast({ text, href })
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        new Notification('ZIPPER CRM', { body: text })
      }
    } catch { /* desktop notifications are a bonus */ }
  }, [owner])

  useEffect(() => {
    if (!enabled) return
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
    } catch { /* ignore */ }
    void poll()
    const t = setInterval(() => { void poll() }, POLL_MS)
    const onFocus = () => { void poll() }
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(t); window.removeEventListener('focus', onFocus) }
  }, [enabled, poll])

  if (!enabled || !toast) return null
  return (
    <div className="fixed bottom-4 right-4 z-[100] max-w-sm rounded-xl border border-pink-500/40 bg-slate-900 shadow-2xl p-4 flex gap-3 items-start">
      <Bell size={18} className="text-pink-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1 text-sm text-slate-200">
        <p>{toast.text}</p>
        <Link href={toast.href} onClick={() => setToast(null)} className="mt-2 inline-block text-pink-400 hover:text-pink-300 font-medium">
          Open →
        </Link>
      </div>
      <button onClick={() => setToast(null)} aria-label="Dismiss" className="text-slate-500 hover:text-slate-300">
        <X size={16} />
      </button>
    </div>
  )
}

'use client'

/**
 * The four states every data view needs.
 *
 * Written once because the CRM previously had pages that showed a blank area
 * while loading, an empty table when there was nothing, and silence when a
 * fetch failed — each page differently, several not at all. A screen that
 * shows nothing is indistinguishable from a screen that is broken.
 *
 * `Empty` and `Unavailable` are the pair that matters most and the pair that
 * was most often collapsed: nothing was found, versus we were not allowed to
 * look. Never reach for `Empty` when the read rejected.
 */

import { AlertTriangle, Inbox, Loader2, RefreshCw, ShieldOff } from 'lucide-react'
import type { ReadFailure } from '@/lib/readState'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <Loader2 size={24} className="animate-spin text-pink-500" />
      <p className="text-slate-500 text-sm">{label}</p>
    </div>
  )
}

export function Empty({
  title = 'Nothing here yet',
  hint,
  icon,
  action,
}: {
  title?: string
  hint?: string
  icon?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
      <div className="text-slate-700 mb-3">{icon ?? <Inbox size={28} />}</div>
      <p className="text-slate-300 text-sm font-medium">{title}</p>
      {hint && <p className="text-slate-600 text-sm mt-1 max-w-sm">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <AlertTriangle size={26} className="text-red-400 mb-3" />
      <p className="text-red-300 text-sm font-medium">Could not load this</p>
      <p className="text-slate-500 text-sm mt-1 max-w-md">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  )
}

export function Denied({ what = 'this page' }: { what?: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-center px-6">
      <ShieldOff size={30} className="text-slate-700" />
      <h1 className="text-white text-xl font-bold">Not available to you</h1>
      <p className="text-slate-500 text-sm max-w-sm">
        Your role does not have access to {what}. If you think it should, ask an
        owner — the change is recorded either way.
      </p>
    </div>
  )
}

/**
 * Shown in place of a NUMBER that could not be read. Never "0", never "—" on
 * its own: a lone dash reads as "nothing happened here", which is the same lie
 * in quieter clothing. The sentence is the point.
 *
 * This is the dashboard's Estimated Platform Revenue treatment, lifted out so
 * every tile in the CRM refuses in the same voice.
 */
export function Unavailable({ failure, what }: { failure: ReadFailure; what?: string }) {
  const lead =
    failure.code === 'permission-denied'
      ? `Not available to your role${what ? ` — ${what}` : ''}.`
      : `Could not be read${what ? ` — ${what}` : ''}. This is not zero.`
  return (
    <>
      <p className="text-2xl font-bold text-slate-500 mt-0.5">—</p>
      <p className="text-yellow-400/80 text-xs mt-0.5 leading-snug">
        {lead} {failure.reason}
      </p>
    </>
  )
}

/**
 * The same refusal at the size of a table cell or a list row, where a
 * two-line block would not fit.
 */
export function UnavailableInline({ failure, label }: { failure: ReadFailure; label?: string }) {
  return (
    <span
      className="text-yellow-400/80 text-xs"
      title={failure.reason}
    >
      {label ?? (failure.code === 'permission-denied' ? 'not yours to see' : 'could not be read')}
    </span>
  )
}

/**
 * A whole panel — chart, table, section — whose read did not complete.
 * Deliberately distinct from `Empty`: this one never claims there is no data.
 */
export function UnavailablePanel({
  failure,
  what,
  onRetry,
}: {
  failure: ReadFailure
  what: string
  onRetry?: () => void
}) {
  const retryable = failure.code === 'unavailable' || failure.code === 'unknown'
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center">
      {failure.code === 'permission-denied' ? (
        <ShieldOff size={24} className="text-yellow-500/70 mb-3" />
      ) : (
        <AlertTriangle size={24} className="text-yellow-500/70 mb-3" />
      )}
      <p className="text-yellow-300 text-sm font-medium">
        {failure.code === 'permission-denied'
          ? `${what} is not available to your role`
          : `${what} could not be read`}
      </p>
      <p className="text-slate-500 text-sm mt-1 max-w-md">{failure.reason}</p>
      <p className="text-slate-600 text-xs mt-2">
        Nothing is shown here because nothing was measured — this is not a zero.
      </p>
      {onRetry && retryable && (
        <button
          onClick={onRetry}
          className="mt-4 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Try again
        </button>
      )}
    </div>
  )
}

/** Inline banner for a non-fatal problem that should not replace the content. */
export function Warning({
  children,
  onDismiss,
}: {
  children: React.ReactNode
  onDismiss?: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="text-amber-100 text-sm">{children}</div>
      </div>
      {onDismiss && (
        <button onClick={onDismiss} className="text-amber-400/70 hover:text-amber-200 text-xs">
          Dismiss
        </button>
      )}
    </div>
  )
}

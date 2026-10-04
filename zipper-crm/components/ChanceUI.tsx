'use client'

/**
 * The pieces every chance screen shares.
 *
 * `ReadPanel` is the important one. Loading, empty, **refused** and error are
 * four different facts and this is the only place the chance screens decide how
 * each of them looks — `lib/readState.ts` classifies the rejection and
 * `components/ui/States.tsx` renders it, so a 403 on the exception queue reads
 * as "your role does not cover this" and never as an empty queue. An empty
 * queue is a real and good answer; a refused read is not an answer at all.
 */

import type { ReactNode } from 'react'
import { CircleSlash, Pause, Radio, Ban } from 'lucide-react'
import type { ReadResult } from '@/lib/readState'
import { Empty, ErrorState, Loading, UnavailablePanel } from '@/components/ui/States'
import type { MechanicState } from '@/lib/apiChance'
import { STATE_TEXT } from '@/lib/apiChance'

/**
 * Render one read in whichever of its four states it is in.
 *
 * `result === null` means the read has not come back yet, which is why loading
 * is a separate parameter from an empty value rather than inferred from one.
 */
export function ReadPanel<T>({
  result,
  what,
  loadingLabel,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyHint,
  emptyIcon,
  children,
}: {
  result: ReadResult<T> | null
  /** Named in the refusal: "the exception queue is not available to your role". */
  what: string
  loadingLabel?: string
  onRetry?: () => void
  /** Only ever called on a successful read. */
  isEmpty?: (value: T) => boolean
  emptyTitle?: string
  emptyHint?: string
  emptyIcon?: ReactNode
  children: (value: T) => ReactNode
}) {
  if (result === null) return <Loading label={loadingLabel ?? `Reading ${what}…`} />

  if (!result.ok) {
    // A refusal and a failure are not the same event and do not read the same.
    if (result.code === 'permission-denied') {
      return <UnavailablePanel failure={result} what={what} />
    }
    return <ErrorState message={result.reason} onRetry={onRetry} />
  }

  if (isEmpty?.(result.value)) {
    return (
      <Empty
        title={emptyTitle ?? `Nothing in ${what}`}
        hint={emptyHint}
        icon={emptyIcon}
      />
    )
  }

  return <>{children(result.value)}</>
}

/** A titled block. Every section on these screens is one. */
export function Panel({
  title,
  subtitle,
  right,
  tone = 'plain',
  children,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  tone?: 'plain' | 'danger' | 'caution' | 'good'
  children: ReactNode
}) {
  const ring =
    tone === 'danger'
      ? 'bg-red-500/10 border-red-500/40'
      : tone === 'caution'
        ? 'bg-amber-500/10 border-amber-500/30'
        : tone === 'good'
          ? 'bg-emerald-500/10 border-emerald-500/30'
          : 'bg-slate-900 border-slate-800'
  return (
    <section className={`border rounded-xl ${ring}`}>
      {(title || right) && (
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 px-4 sm:px-5 pt-4 pb-3">
          <div>
            {title && <h2 className="text-white font-semibold leading-snug">{title}</h2>}
            {subtitle && (
              <p className="text-slate-400 text-sm mt-1 max-w-3xl leading-relaxed">{subtitle}</p>
            )}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </div>
      )}
      <div className="px-4 sm:px-5 pb-4 sm:pb-5">{children}</div>
    </section>
  )
}

/**
 * One measured figure with its unit spelled out.
 *
 * `value` is already formatted, because the formatting is where a diamond
 * becomes a rupee by accident. Null is rendered by the caller as "—", never 0.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'plain',
}: {
  label: string
  value: ReactNode
  unit?: string
  hint?: ReactNode
  tone?: 'plain' | 'good' | 'bad' | 'muted'
}) {
  const colour =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'bad'
        ? 'text-red-300'
        : tone === 'muted'
          ? 'text-slate-500'
          : 'text-white'
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-4 py-3.5">
      <p className="text-slate-500 text-xs uppercase tracking-wide">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold tabular-nums mt-1 ${colour}`}>
        {value}
        {unit && <span className="text-slate-500 text-xs font-normal ml-1.5">{unit}</span>}
      </p>
      {hint && <p className="text-slate-500 text-xs mt-1.5 leading-snug">{hint}</p>}
    </div>
  )
}

/**
 * What a mechanic actually is, in one badge.
 *
 * Nothing is live by default, so nothing here defaults to looking live: a
 * mechanic that is suspended, unconfigured or enabled in no country is coloured
 * and worded as the stopped thing it is.
 */
export function MechanicStateBadge({
  state,
  size = 'normal',
}: {
  state: MechanicState
  size?: 'normal' | 'small'
}) {
  const style: Record<MechanicState, string> = {
    live: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    suspended: 'bg-red-500/15 text-red-200 border-red-500/50',
    unconfigured: 'bg-slate-800 text-slate-400 border-slate-700',
    no_market: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
  }
  const Icon =
    state === 'live' ? Radio : state === 'suspended' ? Pause : state === 'no_market' ? Ban : CircleSlash
  return (
    <span
      title={STATE_TEXT[state].blurb}
      className={`inline-flex items-center gap-1.5 border rounded-full font-medium ${style[state]} ${
        size === 'small' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'
      }`}
    >
      <Icon size={size === 'small' ? 11 : 12} />
      {STATE_TEXT[state].label}
    </span>
  )
}

/** A label/value line for a record panel. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="py-2 border-b border-slate-800/70 last:border-0">
      <p className="text-slate-500 text-xs uppercase tracking-wide">{label}</p>
      <div className="text-slate-200 text-sm mt-0.5">{children}</div>
      {hint && <p className="text-slate-500 text-xs mt-1 leading-snug">{hint}</p>}
    </div>
  )
}

/**
 * A read-only fact staff must not be able to override, said so on the face of
 * it. Used for a self-exclusion and a cooling-off period: there is no route in
 * the API that cancels either, and a control with a disabled button beside it
 * invites somebody to go looking for the enabled one.
 */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-slate-400 text-xs bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2 leading-relaxed">
      {children}
    </p>
  )
}

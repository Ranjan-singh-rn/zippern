'use client'

/**
 * Shared pieces of the coin-seller portal.
 *
 * The vocabulary in here is the important part. A card moves through five
 * stages before anything a seller holds changes, and the two that get confused
 * are `approved` and `executed`. **Approved is not executed.** An owner has
 * signed; the coins do not exist yet. Every label below says so in the seller's
 * own terms, because they are the person who will otherwise go looking for
 * stock that has not been credited.
 *
 * Stage names are transcribed from `Stage` in backend/app/services/cards.py and
 * are the same seven `CardStage` carries in lib/apiPartners.ts.
 */

import { Check } from 'lucide-react'
import type { CardStage } from '@/lib/apiPartners'
import { SUPPORT_EMAIL } from '@/lib/contacts'  // QA #47

/** The order a purchase actually travels in. `rejected`/`failed` leave it. */
export const STAGE_TRACK: CardStage[] = [
  'requested',
  'under_review',
  'awaiting_signoff',
  'approved',
  'executed',
]

/** What each stage means to the seller — not to the person processing it. */
export const STAGE_LABEL: Record<CardStage, string> = {
  requested: 'Requested',
  under_review: 'Under review',
  awaiting_signoff: 'Awaiting sign-off',
  approved: 'Approved — not credited yet',
  executed: 'Executed — coins credited',
  rejected: 'Rejected',
  failed: 'Failed',
}

/** The same thing at length, for the one card the seller is looking at. */
export const STAGE_MEANING: Record<CardStage, string> = {
  requested:
    'Your request is on the money board. Nobody has checked the payment yet and no coins exist.',
  under_review:
    'Someone is checking your payment reference and proof right now. No coins exist yet.',
  awaiting_signoff:
    'The payment has been verified by a second person and is waiting for a business owner to sign it. Still no coins.',
  approved:
    'An owner has signed it. Nothing has moved yet — your coins do not exist until an owner executes the card. Until then your stock is unchanged.',
  executed:
    'Done. The coins are in your inventory and appear in your statement.',
  rejected:
    `This was rejected. The reason is on the card. No money was taken from you by this card — if you have paid, write to ${SUPPORT_EMAIL} with the reference.`,
  failed:
    `This card could not be executed. Nothing was credited. It needs a person — write to ${SUPPORT_EMAIL} with the reference.`,
}

export const STAGE_TONE: Record<CardStage, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
}

/** Where a stage sits on the track, or -1 for the two that leave it. */
export function stageIndex(stage: CardStage): number {
  return STAGE_TRACK.indexOf(stage)
}

/**
 * Requested → under review → awaiting sign-off → approved → executed.
 *
 * Drawn for every purchase so the difference between "signed" and "credited" is
 * visible rather than something the seller has to be told once and remember.
 */
export function StageTrack({ stage }: { stage: CardStage }) {
  const here = stageIndex(stage)
  const off = here < 0

  const SHORT: Record<CardStage, string> = {
    requested: 'Requested',
    under_review: 'Review',
    awaiting_signoff: 'Sign-off',
    approved: 'Approved',
    executed: 'Credited',
    rejected: 'Rejected',
    failed: 'Failed',
  }

  if (off) {
    return (
      <p className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded ${STAGE_TONE[stage]}`}>
        {STAGE_LABEL[stage]}
      </p>
    )
  }

  return (
    <ol className="flex items-center gap-1 overflow-x-auto py-1" aria-label="Progress">
      {STAGE_TRACK.map((s, i) => {
        const done = i < here
        const current = i === here
        return (
          <li key={s} className="flex items-center gap-1 shrink-0">
            <span
              className={`flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium whitespace-nowrap ${
                current
                  ? 'bg-pink-500 text-white'
                  : done
                    ? 'bg-green-500/15 text-green-300'
                    : 'bg-slate-800 text-slate-500'
              }`}
            >
              {done && <Check size={10} />}
              {SHORT[s]}
            </span>
            {i < STAGE_TRACK.length - 1 && (
              <span
                className={`h-px w-3 sm:w-5 ${done ? 'bg-green-500/40' : 'bg-slate-700'}`}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ── Small shared UI ───────────────────────────────────────────────────────────

export function Stat({
  label,
  value,
  tone = 'text-white',
  hint,
}: {
  label: string
  value: React.ReactNode
  tone?: string
  hint?: React.ReactNode
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-[11px] font-medium uppercase tracking-wide">{label}</p>
      <div className={`text-lg font-bold mt-1 break-words ${tone}`}>{value}</div>
      {hint && <div className="text-slate-600 text-xs mt-1">{hint}</div>}
    </div>
  )
}

export function Panel({
  title,
  icon,
  aside,
  children,
}: {
  title: string
  icon?: React.ReactNode
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-slate-800">
        <h2 className="flex items-center gap-2 text-white font-semibold text-sm sm:text-base">
          {icon && <span className="text-slate-500">{icon}</span>}
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

export function Th({
  children,
  align,
  hideOnMobile,
}: {
  children: React.ReactNode
  align?: 'right'
  hideOnMobile?: boolean
}) {
  return (
    <th
      className={`px-3 sm:px-5 py-3 text-slate-400 text-[11px] font-medium uppercase tracking-wide whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${hideOnMobile ? 'hidden sm:table-cell' : ''}`}
    >
      {children}
    </th>
  )
}

export function Labelled({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-slate-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
      {hint && <div className="text-slate-500 text-xs mt-1">{hint}</div>}
    </div>
  )
}

export const inputClass =
  'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500'

export function Info({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <p className="text-slate-500 text-xs">{label}</p>
      <p className={`text-slate-200 text-sm break-words ${mono ? 'font-mono' : ''}`}>
        {value || '—'}
      </p>
    </div>
  )
}

// ── Time ──────────────────────────────────────────────────────────────────────

/** Date and time, for a movement where the time of day matters. */
export function whenExact(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ageOf(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (Number.isNaN(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** `yyyy-mm-dd` for a date input, in local time. */
export function dateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

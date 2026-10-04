'use client'

/**
 * The small pieces the agency's money view is built from, and the period it is
 * scoped to.
 *
 * Kept apart from the sections themselves so that the rules that must hold
 * everywhere — a money figure always names its currency, a figure that could
 * not be read never renders as a number — hold in one place rather than in six.
 */

import { useState } from 'react'
import { Calendar, Info } from 'lucide-react'
import type { ReadFailure } from '@/lib/readState'
import { Unavailable } from '@/components/ui/States'

// ── The period ────────────────────────────────────────────────────────────────
//
// Two modes, because the API genuinely behaves differently in each and
// pretending otherwise is how a lifetime total ends up under a weekly heading.
//
//   window    both `since` and `until` are sent. The ledger totals cover that
//             window, and the commission derivation covers it too — passing
//             both bounds is precisely what makes the server derive YOUR period
//             rather than the current ISO week
//             (backend/app/services/partners.py:150).
//   lifetime  neither bound is sent. The ledger totals are everything on
//             record; the derivation falls back to the current ISO week and
//             says so in `commission_basis.period`.

export type Period =
  | { mode: 'window'; since: Date; until: Date; label: string }
  | { mode: 'lifetime'; label: string }

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** Monday-start, matching the ISO week the commission engine bands on. */
function startOfWeek(weeksAgo = 0): Date {
  const d = new Date()
  const dayFromMonday = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dayFromMonday - weeksAgo * 7)
  return startOfDay(d)
}

function startOfMonth(monthsAgo = 0): Date {
  const now = new Date()
  return startOfDay(new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1))
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return startOfDay(d)
}

function windowPeriod(since: Date, until: Date, label: string): Period {
  return { mode: 'window', since, until, label }
}

export const PERIOD_PRESETS: { key: string; label: string; build: () => Period }[] = [
  {
    key: 'this_week',
    label: 'This week',
    build: () => windowPeriod(startOfWeek(0), endOfDay(new Date()), 'This week'),
  },
  {
    key: 'last_week',
    label: 'Last week',
    build: () =>
      windowPeriod(
        startOfWeek(1),
        new Date(startOfWeek(0).getTime() - 1),
        'Last week',
      ),
  },
  {
    key: 'this_month',
    label: 'This month',
    build: () => windowPeriod(startOfMonth(0), endOfDay(new Date()), 'This month'),
  },
  {
    key: 'last_month',
    label: 'Last month',
    build: () =>
      windowPeriod(
        startOfMonth(1),
        new Date(startOfMonth(0).getTime() - 1),
        'Last month',
      ),
  },
  {
    key: 'last_90',
    label: 'Last 90 days',
    build: () => windowPeriod(daysAgo(90), endOfDay(new Date()), 'Last 90 days'),
  },
  {
    key: 'lifetime',
    label: 'Everything',
    build: () => ({ mode: 'lifetime', label: 'Everything on record' }),
  },
]

export function defaultPeriod(): Period {
  return PERIOD_PRESETS[0].build()
}

/** The query parameters this period sends. Lifetime deliberately sends none. */
export function periodParams(p: Period): { since?: string; until?: string } {
  if (p.mode === 'lifetime') return {}
  return { since: p.since.toISOString(), until: p.until.toISOString() }
}

export function periodDates(p: Period): string {
  if (p.mode === 'lifetime') return 'no start or end — every movement on record'
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  return `${fmt(p.since)} → ${fmt(p.until)}`
}

export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period
  onChange: (p: Period) => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  function applyCustom() {
    if (!from || !to) return
    const since = startOfDay(new Date(from))
    const until = endOfDay(new Date(to))
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return
    if (since > until) return
    onChange(windowPeriod(since, until, `${from} → ${to}`))
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <Calendar size={14} className="text-slate-500 shrink-0" />
        <p className="text-slate-300 text-sm font-medium">Period</p>
        <p className="text-slate-500 text-xs truncate">{periodDates(value)}</p>
      </div>

      {/* Scrolls rather than wraps — an agency owner reads this on a phone. */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {PERIOD_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => onChange(p.build())}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              value.label === p.label
                ? 'bg-pink-500 text-white'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-3">
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          aria-label="Period start"
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-pink-500"
        />
        <span className="text-slate-600 text-xs text-center sm:text-left">to</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Period end"
          className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-white text-xs focus:outline-none focus:border-pink-500"
        />
        <button
          onClick={applyCustom}
          disabled={!from || !to}
          className="bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 rounded-lg px-4 py-2 text-xs font-medium transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

// ── Presentational primitives ─────────────────────────────────────────────────

/**
 * One money figure.
 *
 * `failure` and `value` are mutually exclusive by construction: a tile whose
 * read did not complete renders `<Unavailable>` and cannot be given a number to
 * print instead. There is no `valueOr(0)` here on purpose.
 */
export function MoneyTile({
  label,
  value,
  failure,
  loading,
  hint,
  tone = 'text-white',
}: {
  label: string
  value?: string
  failure?: ReadFailure
  loading?: boolean
  hint?: string
  tone?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-[11px] font-medium uppercase tracking-wide">
        {label}
      </p>
      {failure ? (
        <Unavailable failure={failure} what={label.toLowerCase()} />
      ) : loading ? (
        <>
          <div className="h-7 mt-1 w-24 bg-slate-800 rounded animate-pulse" />
          <p className="text-slate-600 text-[11px] mt-1">Reading the ledger…</p>
        </>
      ) : (
        <>
          <p className={`text-xl sm:text-2xl font-bold mt-1 break-words ${tone}`}>
            {value}
          </p>
          {hint && <p className="text-slate-500 text-[11px] mt-1 leading-snug">{hint}</p>}
        </>
      )}
    </div>
  )
}

export function Section({
  title,
  icon,
  subtitle,
  action,
  children,
}: {
  title: string
  icon: React.ReactNode
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-6">
      <div className="px-4 sm:px-5 py-4 border-b border-slate-800 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <span className="text-slate-500 shrink-0">{icon}</span>
            {title}
          </h2>
          {subtitle && (
            <p className="text-slate-500 text-xs mt-1 leading-relaxed max-w-2xl">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A sentence the server wrote, shown as the server wrote it. */
export function FromTheServer({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-lg px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-slate-500 text-[10px] font-semibold uppercase tracking-wide">
        <Info size={10} className="shrink-0" /> {label}
      </p>
      <p className="text-slate-300 text-sm mt-1.5 leading-relaxed">{children}</p>
    </div>
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
      className={`px-4 sm:px-5 py-3 text-slate-400 text-[11px] font-medium uppercase tracking-wide whitespace-nowrap ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${hideOnMobile ? 'hidden sm:table-cell' : ''}`}
    >
      {children}
    </th>
  )
}

/** Every table on this page states the unit its money column is in. */
export function CurrencyNote({ children }: { children?: React.ReactNode }) {
  return (
    <p className="px-4 sm:px-5 py-2.5 border-t border-slate-800 text-slate-600 text-[11px] leading-relaxed">
      {children ?? (
        <>
          All amounts are Indian Rupees (INR). The API holds them in paise and
          this page divides by 100 once to display them.
        </>
      )}
    </p>
  )
}

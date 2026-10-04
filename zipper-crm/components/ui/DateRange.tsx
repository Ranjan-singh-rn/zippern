'use client'

/**
 * Date range picker with the presets people actually use.
 *
 * The CRM had no date filtering anywhere — every figure was a fixed window
 * someone chose in code, so "how much came in this week" could not be answered.
 * Every money view should mount this.
 */

import { useState } from 'react'
import { Calendar, ChevronDown } from 'lucide-react'

export interface Range {
  since: Date
  until: Date
  label: string
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function endOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return startOfDay(d)
}

/** Monday-start week, matching how the payout run counts a week. */
function startOfWeek(offset = 0) {
  const d = new Date()
  const day = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - day - offset * 7)
  return startOfDay(d)
}

function startOfMonth(offset = 0) {
  const d = new Date()
  return startOfDay(new Date(d.getFullYear(), d.getMonth() - offset, 1))
}

export const PRESETS: { key: string; label: string; build: () => Range }[] = [
  { key: 'today',      label: 'Today',        build: () => ({ since: startOfDay(new Date()), until: endOfDay(new Date()), label: 'Today' }) },
  { key: 'yesterday',  label: 'Yesterday',    build: () => ({ since: daysAgo(1), until: endOfDay(daysAgo(1)), label: 'Yesterday' }) },
  { key: 'this_week',  label: 'This week',    build: () => ({ since: startOfWeek(0), until: endOfDay(new Date()), label: 'This week' }) },
  { key: 'last_week',  label: 'Last week',    build: () => ({ since: startOfWeek(1), until: endOfDay(new Date(startOfWeek(0).getTime() - 1)), label: 'Last week' }) },
  { key: 'this_month', label: 'This month',   build: () => ({ since: startOfMonth(0), until: endOfDay(new Date()), label: 'This month' }) },
  { key: 'last_month', label: 'Last month',   build: () => ({ since: startOfMonth(1), until: endOfDay(new Date(startOfMonth(0).getTime() - 1)), label: 'Last month' }) },
  { key: 'last_30',    label: 'Last 30 days', build: () => ({ since: daysAgo(30), until: endOfDay(new Date()), label: 'Last 30 days' }) },
  { key: 'last_90',    label: 'Last 90 days', build: () => ({ since: daysAgo(90), until: endOfDay(new Date()), label: 'Last 90 days' }) },
]

export function defaultRange(): Range {
  return PRESETS.find((p) => p.key === 'last_30')!.build()
}

export function DateRangePicker({
  value,
  onChange,
}: {
  value: Range
  onChange: (r: Range) => void
}) {
  const [open, setOpen] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  function applyCustom() {
    if (!customFrom || !customTo) return
    const since = startOfDay(new Date(customFrom))
    const until = endOfDay(new Date(customTo))
    if (isNaN(since.getTime()) || isNaN(until.getTime()) || since > until) return
    onChange({
      since,
      until,
      label: `${customFrom} → ${customTo}`,
    })
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-slate-200 transition-colors"
      >
        <Calendar size={14} className="text-slate-500" />
        {value.label}
        <ChevronDown size={13} className="text-slate-600" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-40 w-64 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-2">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => { onChange(p.build()); setOpen(false) }}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  value.label === p.label
                    ? 'bg-pink-500 text-white'
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {p.label}
              </button>
            ))}

            <div className="border-t border-slate-800 mt-2 pt-2 px-1">
              <p className="text-slate-500 text-xs mb-2">Custom range</p>
              <div className="flex items-center gap-1.5">
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-pink-500"
                />
                <span className="text-slate-600 text-xs">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-pink-500"
                />
              </div>
              <button
                onClick={applyCustom}
                disabled={!customFrom || !customTo}
                className="w-full mt-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** ISO strings for the API, which takes `since` and `until` query params. */
export function toParams(r: Range) {
  return { since: r.since.toISOString(), until: r.until.toISOString() }
}

'use client'

/**
 * Daily rewards & tasks (O8, 5 Nov 2026) — the audit list: every daily reward, daily task and ranking reward a person
 * collected, with who, when, what and how much, and the history row it wrote. From the API
 * (`/api/reports/promotions/claims`, the same business-financials gate as Reports → Promotions).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Gift, Loader2, RefreshCw } from 'lucide-react'
import { reports, type PromotionClaimRow, type PromotionClaims, type PromotionKind } from '@/lib/apiReports'

const KINDS: { value: '' | PromotionKind; label: string }[] = [
  { value: '', label: 'All' }, { value: 'daily_reward', label: 'Daily rewards' },
  { value: 'daily_task', label: 'Daily tasks' }, { value: 'leaderboard_reward', label: 'Ranking rewards' },
]
const PERIODS = [{ days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }]

function istStartOfDay(daysBack: number): Date {
  // Midnight IST, `daysBack - 1` days ago (Today = since midnight IST).
  const now = new Date()
  const ist = new Date(now.getTime() + 330 * 60_000)
  const midnightIstUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60_000
  return new Date(midnightIstUtc - (daysBack - 1) * 86_400_000)
}

function ist(at: string | null): string {
  if (!at) return '—'
  return new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function toCsv(rows: PromotionClaimRow[]): string {
  const head = ['time_ist', 'kind', 'uid', 'day', 'what', 'diamonds', 'beans', 'call_cards', 'history_row']
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [head.join(','), ...rows.map((r) => [ist(r.at), r.kind, r.uid, r.day, r.what, r.diamonds, r.beans, r.callCards, r.historyRow].map(q).join(','))].join('\n')
}

export default function PromotionsAuditPage() {
  const [days, setDays] = useState(1)
  const [kind, setKind] = useState<'' | PromotionKind>('')
  const [data, setData] = useState<PromotionClaims | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setData(await reports.promotionClaims({ since: istStartOfDay(days).toISOString(), until: new Date().toISOString(), ...(kind ? { kind } : {}), limit: 2000 }))
    } catch (e) {
      setData(null)
      setError(e instanceof Error ? e.message : 'Could not read the list.')
    } finally {
      setBusy(false)
    }
  }, [days, kind])

  useEffect(() => { void load() }, [load])

  const csvHref = useMemo(() => (data ? `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(data.rows))}` : ''), [data])
  const label = (k: PromotionKind) => KINDS.find((x) => x.value === k)?.label.replace(/s$/, '') ?? k

  return (
    <div className="p-6 max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2"><Gift size={20} className="text-pink-400" /> Daily rewards &amp; tasks</h1>
        <p className="text-slate-400 text-sm mt-1">Every reward a person collected, one row each. Promotional diamonds are never revenue — they are a liability until spent. Totals by day: Reports → Promotions.</p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {PERIODS.map((p) => (
          <button key={p.days} onClick={() => setDays(p.days)} className={`px-3 py-1.5 rounded-lg text-sm ${days === p.days ? 'bg-pink-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{p.label}</button>
        ))}
        <select value={kind} onChange={(e) => setKind(e.target.value as '' | PromotionKind)} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm">
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <button onClick={() => void load()} className="flex items-center gap-1 bg-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-sm">{busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh</button>
        {data && data.rows.length > 0 && <a href={csvHref} download={`zipper-rewards-${days}d.csv`} className="flex items-center gap-1 bg-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-sm"><Download size={14} /> CSV</a>}
      </div>
      {error && <p className="text-red-300 text-sm">{error}</p>}
      {data && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4"><p className="text-slate-400 text-xs uppercase">Claims</p><p className="text-2xl font-bold text-white">{data.totals.claims.toLocaleString('en-IN')}</p></div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4"><p className="text-slate-400 text-xs uppercase">Diamonds given</p><p className="text-2xl font-bold text-sky-300">{data.totals.diamonds.toLocaleString('en-IN')} 💎</p></div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4"><p className="text-slate-400 text-xs uppercase">Host beans given</p><p className="text-2xl font-bold text-orange-300">{data.totals.beans.toLocaleString('en-IN')}</p></div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase"><tr><th className="text-left p-2">Time (IST)</th><th className="text-left p-2">Kind</th><th className="text-left p-2">Person</th><th className="text-left p-2">What</th><th className="text-right p-2">Diamonds</th><th className="text-right p-2">Beans</th></tr></thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={`${r.uid}-${r.at}-${i}`} className="border-t border-slate-800">
                    <td className="p-2 text-slate-300 whitespace-nowrap">{ist(r.at)}</td>
                    <td className="p-2 text-slate-300">{label(r.kind)}</td>
                    <td className="p-2"><Link href={`/users/${encodeURIComponent(r.uid)}`} className="text-pink-300 hover:underline font-mono text-xs">{r.uid}</Link></td>
                    <td className="p-2 text-slate-200">{r.what}{r.callCards > 0 ? ` · ${r.callCards} call card${r.callCards === 1 ? '' : 's'}` : ''}</td>
                    <td className="p-2 text-right text-sky-300">{r.diamonds ? r.diamonds.toLocaleString('en-IN') : '—'}</td>
                    <td className="p-2 text-right text-orange-300">{r.beans ? r.beans.toLocaleString('en-IN') : '—'}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && <tr><td colSpan={6} className="p-4 text-center text-slate-500">Nothing was collected in this period.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

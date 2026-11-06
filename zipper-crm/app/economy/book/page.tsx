'use client'

/**
 * Economy Book (Owner, 6 Nov 2026) — "a proper, transparent diamond ledger".
 *
 * One page that follows every coin and diamond: what Zipper sold or lent to sellers, what was paid and what is still
 * owed, what each seller holds, what sellers sold on to users, what users hold and what they spent in the app — and
 * the logbook of every ledger movement (time, holder, amount, before/after, action, reason, who, reference).
 * Read-only. Figures come from GET /reports/economy-book; a part that could not be read says so and is never 0.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BookOpen, Download, Loader2, RefreshCw } from 'lucide-react'
import { reports, type EconomyBook, type EconomyLedgerRow } from '@/lib/apiReports'

const PERIODS = [
  { days: 1, label: 'Today' }, { days: 7, label: '7 days' }, { days: 30, label: '30 days' }, { days: 365, label: '1 year' },
]

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('en-IN'))
const inr = (minor: number | null | undefined) => (minor === null || minor === undefined ? '—' : `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)
const ist = (at: string) => new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

function startOf(days: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  return d
}

function toCsv(rows: EconomyLedgerRow[]): string {
  const head = ['time_ist', 'holder_type', 'holder_id', 'currency', 'amount', 'balance_before', 'balance_after', 'action', 'reason', 'by', 'by_role', 'reference', 'card_id']
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [head.join(','), ...rows.map((r) => [ist(r.at), r.holder_type, r.holder_id, r.currency, r.amount, r.balance_before, r.balance_after, r.action, r.reason, r.actor.name || r.actor.uid, r.actor.role, r.reference, r.card_id].map(q).join(','))].join('\n')
}

function Stat({ label, value, sub, tone = 'text-white' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs uppercase">{label}</p>
      <p className={`text-2xl font-bold ${tone}`}>{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-1">{sub}</p>}
    </div>
  )
}

export default function EconomyBookPage() {
  const [days, setDays] = useState(30)
  const [holderType, setHolderType] = useState<'' | 'user' | 'seller' | 'agency'>('')
  const [holderId, setHolderId] = useState('')
  const [data, setData] = useState<EconomyBook | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      setData(await reports.economyBook({
        since: startOf(days).toISOString(), until: new Date().toISOString(), limit: 2000,
        ...(holderType ? { holder_type: holderType } : {}), ...(holderId.trim() ? { holder_id: holderId.trim() } : {}),
      }))
    } catch (e) {
      setData(null); setError(e instanceof Error ? e.message : 'Could not read the economy book.')
    } finally { setBusy(false) }
  }, [days, holderType, holderId])

  useEffect(() => { void load() }, [load])
  const csvHref = useMemo(() => (data ? `data:text/csv;charset=utf-8,${encodeURIComponent(toCsv(data.ledger))}` : ''), [data])
  const h = data?.headline

  return (
    <div className="p-6 max-w-7xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2"><BookOpen size={20} className="text-pink-400" /> Economy book</h1>
        <p className="text-slate-400 text-sm mt-1">Every coin and diamond from Zipper → sellers → users → spent, what is still owed, and the logbook of every movement. Read-only.</p>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {PERIODS.map((p) => (
          <button key={p.days} onClick={() => setDays(p.days)} className={`px-3 py-1.5 rounded-lg text-sm ${days === p.days ? 'bg-pink-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{p.label}</button>
        ))}
        <button onClick={() => void load()} className="flex items-center gap-1 bg-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-sm">{busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh</button>
      </div>
      {error && <p className="text-red-300 text-sm">{error}</p>}
      {data && data.unavailable.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-200 text-sm">
          Some figures could not be read and are shown as “—”, not zero: {data.unavailable.join(' · ')}
        </div>
      )}

      {h && (
        <>
          <section className="space-y-2">
            <h2 className="text-white font-semibold">Zipper → sellers</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Sold to sellers (all time)" value={`${n(h.sold_to_sellers_coins)} coins`} sub={`paid ${inr(h.sold_to_sellers_paid_minor)} · this period ${n(data!.wholesale.window_coins)}`} />
              <Stat label="Lent to sellers" value={`${n(h.lent_to_sellers_coins)} coins`} sub={`repaid ${n(h.repaid_by_sellers_coins)}`} />
              <Stat label="Owed to Zipper now" value={`${n(h.borrowed_outstanding_coins)} coins`} tone={h.borrowed_outstanding_coins > 0 ? 'text-amber-300' : 'text-white'} sub="borrowed, not yet repaid" />
              <Stat label="Held by sellers now" value={`${n(h.held_by_sellers_coins)} coins`} />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-white font-semibold">Sellers → users → spent</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Sold by sellers to users" value={`${n(h.sold_by_sellers_to_users_diamonds)} 💎`} sub={`${n(data!.recharges.approved)} sales · pending ${n(data!.recharges.pending_diamonds)} 💎`} tone="text-sky-300" />
              <Stat label="In user wallets now" value={`${n(h.in_user_wallets_diamonds)} 💎`} sub={data!.wallets ? `${n(data!.wallets.wallets)} wallets` : 'unavailable'} tone="text-sky-300" />
              <Stat label="Spent in the app (period)" value={`${n(h.spent_in_app_diamonds_window)} 💎`} sub={data!.app_spend ? `Zipper's cut ${n(data!.app_spend.total.zipper_cut)} 💎` : 'unavailable'} tone="text-pink-300" />
              <Stat label="Host beans held now" value={n(h.in_user_wallets_beans)} sub={data!.app_spend ? `paid to hosts this period ${n(data!.app_spend.total.beans_to_hosts)}` : ''} tone="text-orange-300" />
            </div>
            {data!.app_spend && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-400 text-xs uppercase"><tr><th className="text-left p-2">Spent on</th><th className="text-right p-2">Events</th><th className="text-right p-2">Diamonds</th><th className="text-right p-2">Beans to hosts</th><th className="text-right p-2">Zipper&apos;s cut</th></tr></thead>
                  <tbody>
                    {Object.entries(data!.app_spend.by_type).map(([t, v]) => (
                      <tr key={t} className="border-t border-slate-800"><td className="p-2 text-slate-200 capitalize">{t}</td><td className="p-2 text-right text-slate-300">{n(v.events)}</td><td className="p-2 text-right text-sky-300">{n(v.gross_diamonds)}</td><td className="p-2 text-right text-orange-300">{n(v.beans_to_hosts)}</td><td className="p-2 text-right text-pink-300">{n(v.zipper_cut)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-white font-semibold">Each seller</h2>
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase"><tr><th className="text-left p-2">Seller</th><th className="text-left p-2">Status</th><th className="text-right p-2">Coins on hand</th><th className="text-right p-2">Sold to users</th><th className="text-right p-2">Owes Zipper</th><th className="text-right p-2">Credit limit</th><th className="text-left p-2">Due</th></tr></thead>
                <tbody>
                  {data!.sellers.map((s) => (
                    <tr key={s.id} className="border-t border-slate-800">
                      <td className="p-2"><Link href={`/sellers/${encodeURIComponent(s.id)}`} className="text-pink-300 hover:underline">{s.name || s.id}</Link></td>
                      <td className="p-2 text-slate-400">{s.status}</td>
                      <td className="p-2 text-right text-white">{n(s.coins_on_hand)}</td>
                      <td className="p-2 text-right text-sky-300">{n(s.coins_sold_total)}</td>
                      <td className={`p-2 text-right ${s.borrowed_outstanding > 0 ? 'text-amber-300 font-semibold' : 'text-slate-500'}`}>{n(s.borrowed_outstanding)}</td>
                      <td className="p-2 text-right text-slate-400">{n(s.credit_limit)}</td>
                      <td className="p-2 text-slate-400">{s.credit_due_at ? ist(s.credit_due_at) : '—'}</td>
                    </tr>
                  ))}
                  {data!.sellers.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-slate-500">No sellers yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-white font-semibold mr-2">Logbook — every movement</h2>
          <select value={holderType} onChange={(e) => setHolderType(e.target.value as '' | 'user' | 'seller' | 'agency')} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm">
            <option value="">Everyone</option><option value="user">Users</option><option value="seller">Sellers</option><option value="agency">Agencies</option>
          </select>
          <input value={holderId} onChange={(e) => setHolderId(e.target.value)} placeholder="Holder ID (optional)" className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm" />
          {data && data.ledger.length > 0 && <a href={csvHref} download={`zipper-economy-logbook-${days}d.csv`} className="flex items-center gap-1 bg-slate-800 text-slate-300 rounded-lg px-3 py-1.5 text-sm"><Download size={14} /> CSV</a>}
          {data && <span className="text-slate-500 text-xs">{n(data.ledger_count)} rows</span>}
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-slate-400 text-xs uppercase"><tr><th className="text-left p-2">Time (IST)</th><th className="text-left p-2">Holder</th><th className="text-left p-2">Currency</th><th className="text-right p-2">Amount</th><th className="text-right p-2">Before → after</th><th className="text-left p-2">Action</th><th className="text-left p-2">Reason</th><th className="text-left p-2">By</th><th className="text-left p-2">Reference</th></tr></thead>
            <tbody>
              {(data?.ledger ?? []).map((r) => (
                <tr key={r.id} className="border-t border-slate-800 align-top">
                  <td className="p-2 text-slate-300 whitespace-nowrap">{ist(r.at)}</td>
                  <td className="p-2 text-slate-300"><span className="text-slate-500">{r.holder_type}</span> <span className="font-mono text-xs">{r.holder_id}</span></td>
                  <td className="p-2 text-slate-300">{r.currency}</td>
                  <td className={`p-2 text-right font-semibold ${r.amount >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{r.amount >= 0 ? '+' : ''}{n(r.amount)}</td>
                  <td className="p-2 text-right text-slate-400 whitespace-nowrap">{n(r.balance_before)} → {n(r.balance_after)}</td>
                  <td className="p-2 text-slate-300">{r.action}</td>
                  <td className="p-2 text-slate-400 max-w-xs">{r.reason}</td>
                  <td className="p-2 text-slate-300">{r.actor.name || r.actor.uid || '—'}{r.actor.role ? <span className="text-slate-500"> · {r.actor.role}</span> : null}</td>
                  <td className="p-2 text-slate-500 font-mono text-xs">{r.reference || r.card_id || '—'}</td>
                </tr>
              ))}
              {data && data.ledger.length === 0 && <tr><td colSpan={9} className="p-4 text-center text-slate-500">No movements in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

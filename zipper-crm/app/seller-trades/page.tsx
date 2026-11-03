'use client'

/**
 * Seller-to-seller trades (B9, 3 Nov 2026) — Finance and the Owner.
 *
 * A seller buying coins from another seller files the trade with the payment reference; the selling seller may
 * dispute it ("I was not paid"). Here Finance checks the payment and rejects what does not match; the Owner
 * approves — and only then do the coins move (backend services/seller_business.py: `strade:{id}:debit/credit`,
 * once). A disputed trade cannot be approved; a selling seller short of coins leaves it pending.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ArrowLeftRight, CheckCircle, Loader2 } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { sellerBusiness, type SellerTrade } from '@/lib/apiPartners'

const inr = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export default function SellerTradesPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin', 'finance_admin', 'finance_member'])
  const isOwner = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [rows, setRows] = useState<SellerTrade[] | null>(null)
  const [filter, setFilter] = useState('pending')
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try { setRows(await sellerBusiness.listTrades({ status: filter || undefined })) } catch (e: unknown) {
      setRows([])
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Could not load trades.' })
    }
  }, [filter])

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    load()
  }, [crmUser, allowed, router, load])

  async function decide(t: SellerTrade, approve: boolean) {
    const reason = window.prompt(approve ? 'Approve: how was the payment verified?' : 'Reject: why?') ?? ''
    if (reason.trim().length < 3) return
    setBusy(t.id)
    try {
      if (approve) await sellerBusiness.approveTrade(t.id, reason)
      else await sellerBusiness.rejectTrade(t.id, reason)
      setNotice({ ok: true, msg: approve ? 'Approved — the coins moved.' : 'Rejected — nothing moved.' })
      await load()
    } catch (e: unknown) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'That did not go through.' })
    } finally { setBusy('') }
  }

  if (!allowed) return <div className="flex items-center justify-center min-h-64"><p className="text-slate-400">Access denied.</p></div>
  if (!rows) return <div className="flex items-center justify-center py-32"><Loader2 size={28} className="text-pink-500 animate-spin" /></div>

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2"><ArrowLeftRight size={22} /> Seller-to-seller trades</h1>
        <p className="text-slate-400 text-sm mt-1">Check the payment reference against the bank or UPI statement before approving. The coins move only on the Owner&apos;s approval.</p>
      </div>
      {notice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {notice.msg}
        </div>
      )}
      <div className="flex gap-2">
        {['pending', 'approved', 'rejected', ''].map((s) => (
          <button key={s || 'all'} onClick={() => setFilter(s)} className={`px-3 py-1 rounded-full text-sm ${filter === s ? 'bg-pink-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{s || 'all'}</button>
        ))}
      </div>
      <div className="bg-slate-800 rounded-xl p-4">
        {rows.length === 0 ? <p className="text-slate-400 text-sm">No trades.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Buyer ← Seller</th><th>Coins</th><th>Paid</th><th>Reference</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="align-top">
                  <td>{t.buyer_name || t.buyer_id} ← {t.seller_name || t.seller_id}</td>
                  <td className="text-center">{t.coins.toLocaleString('en-IN')}</td>
                  <td className="text-center">{inr(t.amount_paid_minor)}</td>
                  <td className="text-center font-mono text-xs">{t.payment_ref}</td>
                  <td className="text-center">
                    {t.status}
                    {t.disputed && <div className="text-amber-300 text-xs">disputed: {t.dispute_reason}</div>}
                    {t.shortfall && <div className="text-amber-300 text-xs">seller holds {t.shortfall.available.toLocaleString('en-IN')} of {t.shortfall.needed.toLocaleString('en-IN')}</div>}
                  </td>
                  <td className="text-right space-x-2 whitespace-nowrap">
                    {t.status === 'pending' && isOwner && !t.disputed && (
                      <button disabled={busy === t.id} onClick={() => decide(t, true)} className="text-xs text-emerald-300 hover:text-emerald-200">Approve</button>
                    )}
                    {t.status === 'pending' && (
                      <button disabled={busy === t.id} onClick={() => decide(t, false)} className="text-xs text-red-300 hover:text-red-200">Reject</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

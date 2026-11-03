'use client'

/**
 * B9 (3 Nov 2026) — a coin seller's business in one panel: what they paid, what they sold for and the margin;
 * borrowing within their limit; buying from another seller (and disputing a trade they were not paid for); and,
 * where Zipper allows it, moving their own coins into their own app wallet.
 *
 * Every figure and every decision is the backend's (services/seller_business.py): this panel files requests and
 * shows answers. Nothing here approves, signs or executes — an owner does, on the board and the trades page.
 * `audience="seller"` is the seller portal; `audience="staff"` adds the tier and credit-limit controls.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import { sellerBusiness, type SellerProfit, type SellerTrade } from '@/lib/apiPartners'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'
const inr = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/[^A-Za-z0-9_-]/g, '')

export default function SellerBusinessPanel({ sellerId, audience }: { sellerId: string; audience: 'seller' | 'staff' }) {
  const [profit, setProfit] = useState<SellerProfit | null>(null)
  const [trades, setTrades] = useState<SellerTrade[]>([])
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [borrow, setBorrow] = useState({ coins: 0, days: 14, reason: '' })
  const [trade, setTrade] = useState({ seller: '', coins: 0, rupees: 0, ref: '' })
  const [tradeKey, setTradeKey] = useState(newId())
  const [selfUse, setSelfUse] = useState({ coins: 0, reason: '' })
  const [selfKey, setSelfKey] = useState(newId())
  const [tier, setTier] = useState({ tier: '', reason: '' })
  const [limit, setLimit] = useState({ coins: 0, reason: '' })

  const load = useCallback(async () => {
    try { setProfit(await sellerBusiness.profit(sellerId)) } catch { setProfit(null) }
    try { setTrades(await sellerBusiness.listTrades({ seller_id: sellerId })) } catch { setTrades([]) }
  }, [sellerId])

  useEffect(() => { load() }, [load])

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true)
    try {
      await fn()
      setNotice({ ok: true, msg: done })
      await load()
    } catch (e: unknown) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'That did not go through.' })
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {notice.msg}
        </div>
      )}

      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-semibold mb-2">Margin</h3>
        {!profit ? <p className="text-slate-400 text-sm"><Loader2 size={14} className="inline animate-spin" /> Loading…</p> : (
          <div className="grid md:grid-cols-4 gap-3 text-sm">
            <div><p className="text-slate-400 text-xs">In stock</p><p className="text-white">{profit.inventory_coins.toLocaleString('en-IN')} coins</p></div>
            <div><p className="text-slate-400 text-xs">Bought</p><p className="text-white">{profit.purchased_coins.toLocaleString('en-IN')} for {inr(profit.purchase_cost_minor)}</p>
              <p className="text-slate-500 text-xs">avg ₹{profit.avg_cost_inr_per_lakh.toLocaleString('en-IN')}/lakh{profit.tier ? ` · tier ${profit.tier}` : ''}</p></div>
            <div><p className="text-slate-400 text-xs">Sold</p><p className="text-white">{profit.coins_sold.toLocaleString('en-IN')} for {inr(profit.revenue_minor)}</p>
              <p className="text-slate-500 text-xs">avg ₹{profit.avg_sale_inr_per_lakh.toLocaleString('en-IN')}/lakh</p></div>
            <div><p className="text-slate-400 text-xs">Gross profit</p><p className={profit.gross_profit_minor >= 0 ? 'text-emerald-300' : 'text-red-300'}>{inr(profit.gross_profit_minor)}</p>
              <p className="text-slate-500 text-xs">cost of coins sold {inr(profit.cost_of_sold_minor)}</p></div>
            <div><p className="text-slate-400 text-xs">Credit</p><p className="text-white">{profit.credit_outstanding.toLocaleString('en-IN')} owed</p>
              <p className="text-slate-500 text-xs">{profit.credit_limit > 0 ? `limit ${profit.credit_limit.toLocaleString('en-IN')} · can borrow ${profit.borrow_headroom.toLocaleString('en-IN')}` : 'no limit set'}</p></div>
            <div><p className="text-slate-400 text-xs">Self-use</p><p className="text-white">{profit.self_use_coins.toLocaleString('en-IN')} coins</p></div>
            <p className="md:col-span-4 text-xs text-slate-500">{profit.definitions.gross_profit_minor} {profit.definitions.cost_of_sold_minor}</p>
          </div>
        )}
      </div>

      {audience === 'staff' && (
        <div className="bg-slate-800 rounded-xl p-4 grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h3 className="text-white font-semibold">Tier (sets the wholesale price)</h3>
            <input className={inputCls} placeholder="tier id, e.g. gold — empty for the published price" value={tier.tier} onChange={(e) => setTier({ ...tier, tier: e.target.value })} />
            <input className={inputCls} placeholder="Reason" value={tier.reason} onChange={(e) => setTier({ ...tier, reason: e.target.value })} />
            <button disabled={busy} className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm"
              onClick={() => act(() => sellerBusiness.setTier(sellerId, tier.tier.trim(), tier.reason), 'Tier saved.')}>Save tier</button>
          </div>
          <div className="space-y-2">
            <h3 className="text-white font-semibold">Credit limit (coins)</h3>
            <input className={inputCls} type="number" value={limit.coins} onChange={(e) => setLimit({ ...limit, coins: Number(e.target.value) })} />
            <input className={inputCls} placeholder="Reason" value={limit.reason} onChange={(e) => setLimit({ ...limit, reason: e.target.value })} />
            <button disabled={busy} className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm"
              onClick={() => act(() => sellerBusiness.setCreditLimit(sellerId, limit.coins, limit.reason), 'Credit limit saved.')}>Save limit</button>
          </div>
        </div>
      )}

      <div className="bg-slate-800 rounded-xl p-4 grid md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <h3 className="text-white font-semibold">Borrow inventory</h3>
          <p className="text-xs text-slate-400">Within your limit, repaid by the date you choose (up to 30 days). An owner approves it.</p>
          <input className={inputCls} type="number" placeholder="Coins" value={borrow.coins || ''} onChange={(e) => setBorrow({ ...borrow, coins: Number(e.target.value) })} />
          <input className={inputCls} type="number" placeholder="Days to repay" value={borrow.days} onChange={(e) => setBorrow({ ...borrow, days: Number(e.target.value) })} />
          <input className={inputCls} placeholder="Why" value={borrow.reason} onChange={(e) => setBorrow({ ...borrow, reason: e.target.value })} />
          <button disabled={busy || borrow.coins <= 0} className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm"
            onClick={() => act(() => sellerBusiness.requestBorrow(sellerId, borrow.coins, borrow.days, borrow.reason), 'Borrow request sent for approval.')}>Request</button>
        </div>
        <div className="space-y-2">
          <h3 className="text-white font-semibold">Buy from another seller</h3>
          <p className="text-xs text-slate-400">Pay them first, then file it here with the payment reference. Zipper checks the payment; the coins move when an owner approves.</p>
          <input className={inputCls} placeholder="Their seller id" value={trade.seller} onChange={(e) => setTrade({ ...trade, seller: e.target.value.trim() })} />
          <input className={inputCls} type="number" placeholder="Coins" value={trade.coins || ''} onChange={(e) => setTrade({ ...trade, coins: Number(e.target.value) })} />
          <input className={inputCls} type="number" placeholder="Amount paid (₹)" value={trade.rupees || ''} onChange={(e) => setTrade({ ...trade, rupees: Number(e.target.value) })} />
          <input className={inputCls} placeholder="Payment reference (UTR)" value={trade.ref} onChange={(e) => setTrade({ ...trade, ref: e.target.value })} />
          <button disabled={busy || !trade.seller || trade.coins <= 0 || !trade.ref} className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm"
            onClick={() => act(async () => {
              await sellerBusiness.fileTrade({ buyer_seller_id: sellerId, seller_seller_id: trade.seller, coins: trade.coins,
                amount_paid_minor: Math.round(trade.rupees * 100), payment_ref: trade.ref, client_request_id: tradeKey })
              setTradeKey(newId())
            }, 'Trade filed. It moves when an owner approves it.')}>File trade</button>
        </div>
      </div>

      {audience === 'seller' && (
        <div className="bg-slate-800 rounded-xl p-4 space-y-2">
          <h3 className="text-white font-semibold">Use my coins in the app</h3>
          <p className="text-xs text-slate-400">Where Zipper allows it: moves coins into your own app wallet as diamonds for your own calls and gifts. It is not a sale.</p>
          <div className="grid md:grid-cols-3 gap-2">
            <input className={inputCls} type="number" placeholder="Coins" value={selfUse.coins || ''} onChange={(e) => setSelfUse({ ...selfUse, coins: Number(e.target.value) })} />
            <input className={inputCls} placeholder="Why" value={selfUse.reason} onChange={(e) => setSelfUse({ ...selfUse, reason: e.target.value })} />
            <button disabled={busy || selfUse.coins <= 0} className="bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm"
              onClick={() => act(async () => { await sellerBusiness.selfUse(sellerId, selfUse.coins, selfKey, selfUse.reason); setSelfKey(newId()) }, 'Moved to your app wallet.')}>Move</button>
          </div>
        </div>
      )}

      <div className="bg-slate-800 rounded-xl p-4">
        <h3 className="text-white font-semibold mb-2">Trades with other sellers</h3>
        {trades.length === 0 ? <p className="text-slate-400 text-sm">None yet.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Trade</th><th>Coins</th><th>Paid</th><th>Status</th><th /></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td>{t.buyer_id === sellerId ? `Bought from ${t.seller_name || t.seller_id}` : `Sold to ${t.buyer_name || t.buyer_id}`}</td>
                  <td className="text-center">{t.coins.toLocaleString('en-IN')}</td>
                  <td className="text-center">{inr(t.amount_paid_minor)}</td>
                  <td className="text-center">{t.status}{t.disputed ? ' · disputed' : ''}{t.shortfall ? ' · seller short' : ''}</td>
                  <td className="text-right">
                    {audience === 'seller' && t.seller_id === sellerId && t.status === 'pending' && !t.disputed && (
                      <button disabled={busy} className="text-xs text-amber-300 hover:text-amber-200"
                        onClick={() => act(() => sellerBusiness.disputeTrade(t.id, 'I have not received this payment.'), 'Dispute sent — Zipper will check before anything moves.')}>Not paid</button>
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

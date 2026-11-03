'use client'

/**
 * B9 (3 Nov 2026): seller tiers and self-use, on the economy page.
 *
 *   * `appConfig/economy.sellerTiers` = {tierId: {name, wholesalePriceInr}} — ₹ per lakh. A seller on a tier is
 *     checked against that price when they buy from Zipper (backend reports.parse_seller_tiers: a price above
 *     retail, or not above zero, is ignored there too). Which seller is on which tier is set on the seller's page.
 *   * `appConfig/economy.sellerSelfUseAllowed` — whether a seller may move their own coins into their own app
 *     wallet for calls and gifts (never counted as a sale).
 *
 * Written with its own merge, so it touches only these two fields of the economy document.
 */

import { useEffect, useState } from 'react'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { Plus, Save, Trash2 } from 'lucide-react'
import { db } from '@/lib/firebase'

interface TierRow { id: string; name: string; price: number }

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'

export function tierProblems(rows: TierRow[], retail: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!/^[a-z0-9_-]{1,32}$/.test(r.id)) out.push(`Tier id "${r.id}" — use lowercase letters, digits, - or _.`)
    if (seen.has(r.id)) out.push(`Tier id "${r.id}" is used twice.`)
    seen.add(r.id)
    if (!(r.price > 0)) out.push(`${r.name || r.id}: the price must be above ₹0.`)
    if (retail > 0 && r.price > retail) out.push(`${r.name || r.id}: ₹${r.price} is above the retail price — that is not a wholesale price.`)
  }
  return out
}

export default function SellerTiersEditor({ retailPerLakh, updatedBy }: { retailPerLakh: number; updatedBy: string }) {
  const [rows, setRows] = useState<TierRow[]>([])
  const [selfUse, setSelfUse] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    getDoc(doc(db, 'appConfig', 'economy')).then((snap) => {
      const tiers = (snap.get('sellerTiers') ?? {}) as Record<string, { name?: string; wholesalePriceInr?: number }>
      setRows(Object.entries(tiers).map(([id, t]) => ({ id, name: String(t?.name ?? id), price: Number(t?.wholesalePriceInr ?? 0) })))
      setSelfUse(snap.get('sellerSelfUseAllowed') === true)
    }).catch(() => setMsg('Could not read the seller tiers.'))
  }, [])

  async function save() {
    const problems = tierProblems(rows, retailPerLakh)
    if (problems.length) { setMsg(problems.join(' ')); return }
    try {
      await setDoc(doc(db, 'appConfig', 'economy'), {
        sellerTiers: Object.fromEntries(rows.map((r) => [r.id, { name: r.name.trim() || r.id, wholesalePriceInr: r.price }])),
        sellerSelfUseAllowed: selfUse,
        updatedAt: serverTimestamp(),
        updatedBy,
      }, { merge: true })
      setMsg('Saved.')
    } catch { setMsg('Save failed — Tech and the Owner keep the economy settings.') }
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <h3 className="text-white font-medium">Seller tiers</h3>
      <p className="text-slate-500 text-xs">A seller on a tier buys at that tier&apos;s price per lakh; everyone else at the wholesale price above. Assign tiers on each seller&apos;s page.</p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_1fr_auto] gap-2 items-center">
          <input className={inputCls} placeholder="id (gold)" value={r.id} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, id: e.target.value.trim().toLowerCase() } : x)))} />
          <input className={inputCls} placeholder="Name" value={r.name} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
          <input className={inputCls} type="number" placeholder="₹ per lakh" value={r.price || ''} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, price: Number(e.target.value) } : x)))} />
          <button onClick={() => setRows(rows.filter((_, k) => k !== i))} className="text-slate-400 hover:text-red-300"><Trash2 size={14} /></button>
        </div>
      ))}
      <button onClick={() => setRows([...rows, { id: '', name: '', price: 0 }])} className="flex items-center gap-1 text-sm text-pink-300 hover:text-pink-200"><Plus size={14} /> Add tier</button>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={selfUse} onChange={(e) => setSelfUse(e.target.checked)} />
        Sellers may use their own coins for their own calls and gifts (moved to their app wallet; never a sale)
      </label>
      <div className="flex items-center gap-3">
        <button onClick={save} className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg px-3 py-1.5 text-sm"><Save size={14} /> Save tiers</button>
        {msg && <span className="text-xs text-slate-400">{msg}</span>}
      </div>
    </div>
  )
}

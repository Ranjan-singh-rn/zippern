'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import Link from 'next/link'
import {
  getRechargePackages, saveRechargePackage, deleteRechargePackage,
  getDiamondPacks, saveDiamondPack, deleteDiamondPack,
  DEFAULT_RECHARGE_PACKAGES, DEFAULT_DIAMOND_PACKS,
  type RechargePackage, type DiamondPack,
} from '@/lib/appConfig'
import { getEconomyConfig } from '@/lib/economyConfig'
import { Loader2, Plus, Trash2, Save, CheckCircle, AlertTriangle, ToggleLeft, ToggleRight, Globe, Zap, ExternalLink } from 'lucide-react'
import LocalPricesModal from '@/components/LocalPricesModal'

// ── Shared helpers ────────────────────────────────────────────────────────────

function numId() { return Date.now().toString(36) }

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'

function fmt(n: number) {
  return n.toLocaleString('en-IN')
}

/** Compute price for a package from the Economy Config base rate (per 1,00,000 diamonds) */
function priceFromRate(totalDiamonds: number, rateInr: number, rateUsd: number): { priceInr: number; priceUsd: number } {
  const ratio = totalDiamonds / 100000
  return {
    priceInr: Math.round(ratio * rateInr),
    priceUsd: Math.round(ratio * rateUsd * 100) / 100,
  }
}

/**
 * The live Economy Config rate driving this tab's prices.
 *
 * `label` is not decoration. The banner used to say "Base rate" on both tabs
 * while a single shared number fed both, so the two tabs showed the same figure
 * and there was nothing on screen to say one of them was the wrong price. Naming
 * which rate this is makes the next mismatch visible instead of silent.
 */
function RateBanner({ rateInr, rateUsd, label }: { rateInr: number; rateUsd: number; label: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl px-4 py-2.5 mb-3 text-xs">
      <p className="text-cyan-300">
        {label}: <strong>₹{rateInr.toLocaleString('en-IN')}</strong> / <strong>${rateUsd}</strong> per 1,00,000 💎
        <span className="text-cyan-400/70 ml-1">— set in Economy Config</span>
      </p>
      <Link href="/economy/config" target="_blank"
        className="flex items-center gap-1 text-cyan-300 hover:text-white underline whitespace-nowrap flex-shrink-0">
        Edit rate <ExternalLink size={11} />
      </Link>
    </div>
  )
}

/** Click-to-edit number cell — shows formatted number, switches to raw input on click */
function NumCell({ value, onChange, highlight }: { value: number; onChange: (v: number) => void; highlight?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(String(value))

  // Keep draft in sync when parent changes value while not editing
  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  function commit() {
    const parsed = parseInt(draft.replace(/,/g, ''), 10)
    if (!isNaN(parsed)) onChange(parsed)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
        className="min-w-[90px] w-full bg-slate-600 border border-pink-500 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`min-w-[80px] w-full text-left px-2 py-1.5 rounded-lg border border-transparent hover:border-pink-500/50 hover:bg-slate-700 transition-colors text-sm font-medium ${
        highlight ? 'text-yellow-300 cursor-default' : 'text-white'
      }`}
    >
      {fmt(value)}
    </button>
  )
}

function Toast({ msg, type }: { msg: string; type: 'ok' | 'err' }) {
  return (
    <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border ${
      type === 'ok'
        ? 'bg-green-500/10 border-green-500/30 text-green-400'
        : 'bg-red-500/10 border-red-500/30 text-red-400'
    }`}>
      {type === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
      {msg}
    </div>
  )
}

// ── Recharge Packages tab ─────────────────────────────────────────────────────

function RechargeTab({ showToast, rateInr, rateUsd }: { showToast: (msg: string, t: 'ok'|'err') => void; rateInr: number; rateUsd: number }) {
  const [pkgs, setPkgs] = useState<RechargePackage[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [recalculating, setRecalculating] = useState(false)
  const [openPricesFor, setOpenPricesFor] = useState<string | null>(null)

  useEffect(() => {
    getRechargePackages()
      .then(data => {
        const defaults = DEFAULT_RECHARGE_PACKAGES.map((p, i) => ({ ...p, id: `rp_${i+1}` }))
        const fsMap = new Map(data.map(p => [p.id, p]))
        // Merge: keep all defaults but replace with Firestore version where saved
        const merged = defaults.map(d => fsMap.get(d.id) ?? d)
        // Include any extra Firestore packages not in defaults (user-created)
        const extras = data.filter(p => !defaults.find(d => d.id === p.id))
        setPkgs([...merged, ...extras].sort((a, b) => a.sortOrder - b.sortOrder))
      })
      .catch(() => setPkgs(DEFAULT_RECHARGE_PACKAGES.map((p, i) => ({ ...p, id: `rp_${i+1}` }))))
      .finally(() => setLoading(false))
  }, [])

  async function save(pkg: RechargePackage) {
    setSaving(s => ({ ...s, [pkg.id]: true }))
    try { await saveRechargePackage(pkg); showToast('Saved', 'ok') }
    catch { showToast('Save failed', 'err') }
    finally { setSaving(s => ({ ...s, [pkg.id]: false })) }
  }

  async function remove(id: string) {
    if (!confirm('Delete this package?')) return
    await deleteRechargePackage(id)
    setPkgs(p => p.filter(x => x.id !== id))
    showToast('Deleted', 'ok')
  }

  function patch(id: string, field: keyof RechargePackage, val: unknown) {
    setPkgs(p => p.map(x => x.id === id ? { ...x, [field]: val } : x))
  }

  function addNew() {
    const id = `rp_${numId()}`
    setPkgs(p => [...p, { id, label: 'New Package', priceInr: 0, priceUsd: 0, baseDiamonds: 0, bonusDiamonds: 0, badge: '', isActive: true, sortOrder: p.length + 1 }])
  }

  async function saveLocalPrices(pkg: RechargePackage, prices: Record<string, number>) {
    const updated = { ...pkg, localPrices: prices }
    setPkgs(p => p.map(x => x.id === pkg.id ? updated : x))
    await saveRechargePackage(updated)
    showToast('Country prices saved', 'ok')
  }

  async function recalcAll() {
    setRecalculating(true)
    try {
      const updated = pkgs.map(p => ({ ...p, ...priceFromRate(p.baseDiamonds + p.bonusDiamonds, rateInr, rateUsd) }))
      setPkgs(updated)
      await Promise.all(updated.map(p => saveRechargePackage(p)))
      showToast(`Recalculated & saved ${updated.length} packages`, 'ok')
    } catch { showToast('Recalculate failed', 'err') }
    finally { setRecalculating(false) }
  }

  const modalPkg = openPricesFor ? pkgs.find(p => p.id === openPricesFor) : null

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-pink-500" /></div>

  return (
    <div className="space-y-3">
      {modalPkg && (
        <LocalPricesModal
          packageLabel={modalPkg.label}
          priceUsd={modalPkg.priceUsd ?? 0}
          localPrices={modalPkg.localPrices ?? {}}
          onSave={prices => saveLocalPrices(modalPkg, prices)}
          onClose={() => setOpenPricesFor(null)}
        />
      )}

      <RateBanner rateInr={rateInr} rateUsd={rateUsd} label="Retail rate (what a user pays)" />

      <div className="flex items-center justify-between mb-2">
        <p className="text-slate-400 text-xs">Shown in the app's Diamond Shop. Users buy diamonds to spend on calls and gifts.</p>
        <div className="flex items-center gap-2">
          <button onClick={recalcAll} disabled={recalculating}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-50 text-cyan-300 border border-cyan-500/30 rounded-lg text-xs font-medium transition-colors">
            {recalculating ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Recalculate from Economy Config
          </button>
          <button onClick={addNew} className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 border border-pink-500/30 rounded-lg text-xs font-medium transition-colors">
            <Plus size={12} />Add Package
          </button>
        </div>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
        <table className="text-sm whitespace-nowrap w-full">
          <thead>
            <tr className="bg-slate-700/50 text-slate-300 text-xs">
              <th className="px-3 py-2.5 text-left font-semibold sticky left-0 bg-slate-700/90">Label</th>
              <th className="px-3 py-2.5 text-left font-semibold">Price (₹)</th>
              <th className="px-3 py-2.5 text-left font-semibold">Price ($)</th>
              <th className="px-3 py-2.5 text-left font-semibold">Base 💎</th>
              <th className="px-3 py-2.5 text-left font-semibold">Bonus 💎</th>
              <th className="px-3 py-2.5 text-left font-semibold">Total 💎</th>
              <th className="px-3 py-2.5 text-left font-semibold">Badge</th>
              <th className="px-3 py-2.5 text-left font-semibold">Active</th>
              <th className="px-3 py-2.5 text-left font-semibold">Order</th>
              <th className="px-3 py-2.5 text-left font-semibold">Country Prices</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pkgs.map(pkg => {
              const priceCount = Object.keys(pkg.localPrices ?? {}).length
              return (
                <tr key={pkg.id} className="hover:bg-slate-700/20">
                  <td className="px-3 py-2 sticky left-0 bg-slate-800"><input value={pkg.label} onChange={e => patch(pkg.id, 'label', e.target.value)} className={inputCls} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.priceInr} onChange={v => patch(pkg.id, 'priceInr', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.priceUsd ?? 0} onChange={v => patch(pkg.id, 'priceUsd', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.baseDiamonds} onChange={v => patch(pkg.id, 'baseDiamonds', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.bonusDiamonds} onChange={v => patch(pkg.id, 'bonusDiamonds', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.baseDiamonds + pkg.bonusDiamonds} onChange={() => {}} highlight /></td>
                  <td className="px-3 py-2">
                    <select value={pkg.badge} onChange={e => patch(pkg.id, 'badge', e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded-lg px-2 py-2 text-white text-xs focus:outline-none focus:border-pink-500">
                      <option value="">—</option>
                      <option value="MOST POPULAR">MOST POPULAR</option>
                      <option value="BEST VALUE">BEST VALUE</option>
                      <option value="HOT">HOT</option>
                      <option value="NEW">NEW</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => patch(pkg.id, 'isActive', !pkg.isActive)}>
                      {pkg.isActive ? <ToggleRight size={22} className="text-green-400" /> : <ToggleLeft size={22} className="text-slate-600" />}
                    </button>
                  </td>
                  <td className="px-3 py-2"><input type="number" value={pkg.sortOrder} onChange={e => patch(pkg.id, 'sortOrder', +e.target.value)} className={inputCls + ' w-16'} /></td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpenPricesFor(pkg.id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        priceCount > 0
                          ? 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20'
                          : 'bg-slate-700/50 border-slate-600/50 text-slate-400 hover:border-pink-500/50 hover:text-white'
                      }`}
                    >
                      <Globe size={11} />
                      {priceCount > 0 ? `${priceCount} set` : 'Set prices'}
                    </button>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => save(pkg)} disabled={!!saving[pkg.id]}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
                        {saving[pkg.id] ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}Save
                      </button>
                      <button onClick={() => remove(pkg.id)} className="p-1.5 text-red-500/60 hover:text-red-400 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Seller Wholesale tab ──────────────────────────────────────────────────────

function WholesaleTab({ showToast, rateInr, rateUsd }: { showToast: (msg: string, t: 'ok'|'err') => void; rateInr: number; rateUsd: number }) {
  const [pkgs, setPkgs] = useState<DiamondPack[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [recalculating, setRecalculating] = useState(false)
  const [openPricesFor, setOpenPricesFor] = useState<string | null>(null)

  useEffect(() => {
    getDiamondPacks()
      .then(data => {
        const defaults = DEFAULT_DIAMOND_PACKS.map((p, i) => ({ ...p, id: `dp_${i+1}` }))
        const fsMap = new Map(data.map(p => [p.id, p]))
        const merged = defaults.map(d => fsMap.get(d.id) ?? d)
        const extras = data.filter(p => !defaults.find(d => d.id === p.id))
        setPkgs([...merged, ...extras].sort((a, b) => a.sortOrder - b.sortOrder))
      })
      .catch(() => setPkgs(DEFAULT_DIAMOND_PACKS.map((p, i) => ({ ...p, id: `dp_${i+1}` }))))
      .finally(() => setLoading(false))
  }, [])

  async function save(pkg: DiamondPack) {
    setSaving(s => ({ ...s, [pkg.id]: true }))
    try { await saveDiamondPack(pkg); showToast('Saved', 'ok') }
    catch { showToast('Save failed', 'err') }
    finally { setSaving(s => ({ ...s, [pkg.id]: false })) }
  }

  async function remove(id: string) {
    if (!confirm('Delete this pack?')) return
    await deleteDiamondPack(id)
    setPkgs(p => p.filter(x => x.id !== id))
    showToast('Deleted', 'ok')
  }

  function patch(id: string, field: keyof DiamondPack, val: unknown) {
    setPkgs(p => p.map(x => x.id === id ? { ...x, [field]: val } : x))
  }

  async function saveLocalPrices(pkg: DiamondPack, prices: Record<string, number>) {
    const updated = { ...pkg, localPrices: prices }
    setPkgs(p => p.map(x => x.id === pkg.id ? updated : x))
    await saveDiamondPack(updated)
    showToast('Country prices saved', 'ok')
  }

  async function recalcAll() {
    setRecalculating(true)
    try {
      const updated = pkgs.map(p => ({ ...p, ...priceFromRate(p.baseDiamonds + p.bonusDiamonds, rateInr, rateUsd) }))
      setPkgs(updated)
      await Promise.all(updated.map(p => saveDiamondPack(p)))
      showToast(`Recalculated & saved ${updated.length} packs`, 'ok')
    } catch { showToast('Recalculate failed', 'err') }
    finally { setRecalculating(false) }
  }

  const modalPkg = openPricesFor ? pkgs.find(p => p.id === openPricesFor) : null

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-pink-500" /></div>

  return (
    <div className="space-y-3">
      {modalPkg && (
        <LocalPricesModal
          packageLabel={modalPkg.label}
          priceUsd={modalPkg.priceUsd ?? 0}
          localPrices={modalPkg.localPrices ?? {}}
          onSave={prices => saveLocalPrices(modalPkg, prices)}
          onClose={() => setOpenPricesFor(null)}
        />
      )}

      <RateBanner rateInr={rateInr} rateUsd={rateUsd} label="Wholesale rate (what a coin seller pays)" />

      <div className="flex items-center justify-between mb-2">
        <p className="text-slate-400 text-xs">Bulk diamond packs sellers buy from Zipper. No bonus — sellers receive exactly what they pay for.</p>
        <div className="flex items-center gap-2">
          <button onClick={recalcAll} disabled={recalculating}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-50 text-cyan-300 border border-cyan-500/30 rounded-lg text-xs font-medium transition-colors">
            {recalculating ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Recalculate from Economy Config
          </button>
          <button onClick={() => setPkgs(p => [...p, { id: `dp_${numId()}`, label: 'New Pack', priceInr: 0, priceUsd: 0, baseDiamonds: 0, bonusDiamonds: 0, isActive: true, sortOrder: p.length + 1 }])}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 border border-pink-500/30 rounded-lg text-xs font-medium transition-colors">
            <Plus size={12} />Add Pack
          </button>
        </div>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
        <table className="text-sm whitespace-nowrap w-full">
          <thead>
            <tr className="bg-slate-700/50 text-slate-300 text-xs">
              <th className="px-3 py-2.5 text-left font-semibold sticky left-0 bg-slate-700/90">Label</th>
              <th className="px-3 py-2.5 text-left font-semibold">Price (₹)</th>
              <th className="px-3 py-2.5 text-left font-semibold">Price ($)</th>
              <th className="px-3 py-2.5 text-left font-semibold">Diamonds 💎</th>
              <th className="px-3 py-2.5 text-left font-semibold">Active</th>
              <th className="px-3 py-2.5 text-left font-semibold">Order</th>
              <th className="px-3 py-2.5 text-left font-semibold">Country Prices</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {pkgs.map(pkg => {
              const priceCount = Object.keys(pkg.localPrices ?? {}).length
              return (
                <tr key={pkg.id} className="hover:bg-slate-700/20">
                  <td className="px-3 py-2 sticky left-0 bg-slate-800"><input value={pkg.label} onChange={e => patch(pkg.id, 'label', e.target.value)} className={inputCls} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.priceInr} onChange={v => patch(pkg.id, 'priceInr', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.priceUsd ?? 0} onChange={v => patch(pkg.id, 'priceUsd', v)} /></td>
                  <td className="px-3 py-2"><NumCell value={pkg.baseDiamonds} onChange={v => patch(pkg.id, 'baseDiamonds', v)} highlight /></td>
                  <td className="px-3 py-2">
                    <button onClick={() => patch(pkg.id, 'isActive', !pkg.isActive)}>
                      {pkg.isActive ? <ToggleRight size={22} className="text-green-400" /> : <ToggleLeft size={22} className="text-slate-600" />}
                    </button>
                  </td>
                  <td className="px-3 py-2"><input type="number" value={pkg.sortOrder} onChange={e => patch(pkg.id, 'sortOrder', +e.target.value)} className={inputCls + ' w-16'} /></td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpenPricesFor(pkg.id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        priceCount > 0
                          ? 'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20'
                          : 'bg-slate-700/50 border-slate-600/50 text-slate-400 hover:border-pink-500/50 hover:text-white'
                      }`}
                    >
                      <Globe size={11} />
                      {priceCount > 0 ? `${priceCount} set` : 'Set prices'}
                    </button>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => save(pkg)} disabled={!!saving[pkg.id]}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
                        {saving[pkg.id] ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}Save
                      </button>
                      <button onClick={() => remove(pkg.id)} className="p-1.5 text-red-500/60 hover:text-red-400 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'recharge' | 'wholesale'

export default function PackagesPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('recharge')
  const [toast, setToast] = useState<{ msg: string; type: 'ok'|'err' } | null>(null)
  /*
   * TWO rates, because there are two prices and they are not the same number.
   *
   * There used to be one `rateInr` shared by both tabs, and it has now been
   * wrong in both directions. It first held the RETAIL price and the wholesale
   * tab quoted it, so coin sellers were charged what their own customers pay.
   * That was fixed by pointing the single rate at the wholesale price — which
   * moved the bug rather than removing it: the user recharge tab then priced a
   * lakh of diamonds at the seller's ₹2,000 instead of the retail ₹3,000.
   *
   * At those figures every user recharge sold a lakh of diamonds for ₹1,000
   * less than it should, AND left the coin seller with no margin at all — they
   * buy at 2,000 and their customer can buy direct at 2,000, so there is
   * nothing in it for them and no reason to sell.
   *
   * One variable could not be two prices. Each tab now takes its own.
   */
  const [retailInr, setRetailInr] = useState(3000)
  const [wholesaleInr, setWholesaleInr] = useState(2000)
  const [rateUsd, setRateUsd] = useState(20)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
  }, [crmUser, router])

  // Live base rate (₹/$ per 1,00,000 diamonds) from Economy Config.
  //
  // These are the packs a COIN SELLER buys from Zipper — the screen says so —
  // so the rate that prices them is the WHOLESALE one. It was the retail price,
  // which meant the tab labelled "Seller Wholesale" priced every pack at what
  // the seller's own customers pay, and Recalculate wrote that back to
  // Firestore. The Android buy-coins screen quotes `priceInr` to the seller as
  // the amount to transfer, so the wrong number reached them directly.
  //
  // `sellerWholesalePriceInr` falls back to the retail price when no discount
  // is configured, so a business that has not set one is unaffected.
  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) return
    getEconomyConfig().then(cfg => {
      // Retail is what a user pays. Wholesale is what a coin seller pays, and
      // it falls back to retail when no discount is configured — a business
      // that has not set one gives no discount rather than a free one.
      setRetailInr(cfg.diamondPackPriceInr)
      setWholesaleInr(cfg.sellerWholesalePriceInr || cfg.diamondPackPriceInr)
      setRateUsd(cfg.diamondPackPriceUsd)
    }).catch(() => {})
  }, [crmUser])

  const showToast = useCallback((msg: string, type: 'ok'|'err') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }, [])

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  const tabs: { key: Tab; label: string; desc: string }[] = [
    { key: 'recharge',  label: '💎 User Recharge',   desc: 'DiamondShopScreen.kt' },
    { key: 'wholesale', label: '🏭 Seller Wholesale', desc: 'DiamondPack.kt' },
  ]

  return (
    <div className="max-w-full mx-auto">
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      <h1 className="text-2xl font-bold text-white mb-1">Packages</h1>
      <p className="text-slate-400 text-sm mb-6">All purchase packages previously hardcoded in the app. Changes here reflect immediately once the app reads from Firestore.</p>

      <div className="flex gap-1 mb-6 bg-slate-900 border border-slate-800 rounded-xl p-1">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 flex flex-col items-center px-3 py-2.5 rounded-lg text-xs font-semibold transition-colors ${
              tab === t.key ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'
            }`}>
            <span>{t.label}</span>
            <span className={`text-xs font-normal mt-0.5 ${tab === t.key ? 'text-pink-200' : 'text-slate-600'}`}>{t.desc}</span>
          </button>
        ))}
      </div>

      {tab === 'recharge'  && <RechargeTab showToast={showToast} rateInr={retailInr} rateUsd={rateUsd} />}
      {tab === 'wholesale' && <WholesaleTab showToast={showToast} rateInr={wholesaleInr} rateUsd={rateUsd} />}
    </div>
  )
}

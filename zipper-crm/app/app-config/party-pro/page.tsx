'use client'

/**
 * Party Pro (B7, 3 Nov 2026) — the Owner's settings for private party rooms, and who on staff may enter one.
 *
 *   * `appConfig/partySubscription`: on/off, whether private rooms need it, the ₹ price (paid in diamonds at the
 *     economy's diamond price, or a diamond price set outright), the level that unlocks it, and the period.
 *     Saved exactly as functions/src/partySubscription.ts reads it (`mergeSubConfig`). Owner-only (rules E7).
 *   * Official access: staff who may enter a private room without its PIN, for moderation. Every such entry is in
 *     the room's access log and shown to the people in the room; the Owner always has it.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where } from 'firebase/firestore'
import { AlertTriangle, CheckCircle, Crown, Loader2, Save } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { OFFICIAL_ACCESS_ROLES, type SubConfig, mergeSubConfig, priceInDiamonds } from '@/lib/partyProGuard'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'

interface Staff { uid: string; name: string; role: string; privateRoomAccess: boolean }

export default function PartyProPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [cfg, setCfg] = useState<SubConfig | null>(null)
  const [perLakh, setPerLakh] = useState<unknown>(undefined)
  const [staff, setStaff] = useState<Staff[]>([])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    const [snap, eco] = await Promise.all([getDoc(doc(db, 'appConfig', 'partySubscription')), getDoc(doc(db, 'appConfig', 'economy'))])
    setCfg(mergeSubConfig(snap.exists() ? snap.data() : undefined))
    setPerLakh(eco.exists() ? eco.get('diamondPackPriceInr') : undefined)
    try {
      const rows = await getDocs(query(collection(db, 'crmUsers'), where('role', 'in', [...OFFICIAL_ACCESS_ROLES].slice(0, 10))))
      setStaff(rows.docs.map((d) => ({
        uid: d.id, name: String(d.get('name') ?? d.get('displayName') ?? d.get('email') ?? d.id),
        role: String(d.get('role') ?? ''), privateRoomAccess: d.get('privateRoomAccess') === true,
      })))
    } catch { setStaff([]) }
  }, [])

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    load().catch(() => setNotice({ ok: false, msg: 'Could not load Party Pro settings.' }))
  }, [crmUser, allowed, router, load])

  async function save() {
    if (!cfg) return
    const clean = mergeSubConfig(cfg)
    setSaving(true)
    try {
      await setDoc(doc(db, 'appConfig', 'partySubscription'), { ...clean, updatedAt: serverTimestamp(), updatedBy: crmUser?.uid ?? '' })
      setNotice({ ok: true, msg: 'Saved. New purchases and renewals use these settings.' })
      await load()
    } catch { setNotice({ ok: false, msg: 'Save failed — only the Owner may change Party Pro.' }) } finally { setSaving(false) }
  }

  async function grant(s: Staff, on: boolean) {
    try {
      await updateDoc(doc(db, 'crmUsers', s.uid), { privateRoomAccess: on })
      setStaff((list) => list.map((x) => (x.uid === s.uid ? { ...x, privateRoomAccess: on } : x)))
    } catch { setNotice({ ok: false, msg: 'Could not change official access.' }) }
  }

  if (!allowed) return <div className="flex items-center justify-center min-h-64"><p className="text-slate-400">Access denied.</p></div>
  if (!cfg) return <div className="flex items-center justify-center py-32"><Loader2 size={28} className="text-pink-500 animate-spin" /></div>
  const price = priceInDiamonds(mergeSubConfig(cfg), perLakh)

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2"><Crown size={22} /> Party Pro — private rooms</h1>
          <p className="text-slate-400 text-sm mt-1">
            A private party room (four-digit PIN) is Party Pro: the level below, and an unexpired subscription the
            server takes the diamonds for. Renewal is from the wallet each period; a cancelled one runs to its end.
          </p>
        </div>
        <button onClick={save} disabled={saving} className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>
      {notice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {notice.msg}
        </div>
      )}
      <div className="bg-slate-800 rounded-xl p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm text-white"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> Party Pro on</label>
        <label className="flex items-center gap-2 text-sm text-white"><input type="checkbox" checked={cfg.required} onChange={(e) => setCfg({ ...cfg, required: e.target.checked })} /> Private rooms need Party Pro (off: anyone may open one)</label>
        <div className="grid md:grid-cols-4 gap-3">
          <div><p className="text-xs text-slate-400 mb-1">Price (₹)</p><input className={inputCls} type="number" value={cfg.priceInr} onChange={(e) => setCfg({ ...cfg, priceInr: Number(e.target.value) })} /></div>
          <div><p className="text-xs text-slate-400 mb-1">Or diamonds outright (0 = from ₹)</p><input className={inputCls} type="number" value={cfg.priceDiamonds} onChange={(e) => setCfg({ ...cfg, priceDiamonds: Number(e.target.value) })} /></div>
          <div><p className="text-xs text-slate-400 mb-1">Unlocks at level</p><input className={inputCls} type="number" value={cfg.minLevel} onChange={(e) => setCfg({ ...cfg, minLevel: Number(e.target.value) })} /></div>
          <div><p className="text-xs text-slate-400 mb-1">Period (days)</p><input className={inputCls} type="number" value={cfg.days} onChange={(e) => setCfg({ ...cfg, days: Number(e.target.value) })} /></div>
        </div>
        <p className="text-sm text-slate-300">A player pays ◆ {price.toLocaleString('en-IN')} for {mergeSubConfig(cfg).days} days.</p>
      </div>
      <div className="bg-slate-800 rounded-xl p-4">
        <h2 className="text-white font-semibold mb-1">Official access to private rooms</h2>
        <p className="text-xs text-slate-400 mb-3">Staff switched on here may enter a private room without its PIN — for moderation. It is never silent: the entry is in the room&apos;s access log and shown in the room.</p>
        {staff.length === 0 ? <p className="text-slate-400 text-sm">No staff accounts found.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Staff</th><th className="text-left">Role</th><th>May enter</th></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.uid}>
                  <td>{s.name}</td><td>{s.role}</td>
                  <td className="text-center"><input type="checkbox" checked={s.privateRoomAccess} onChange={(e) => grant(s, e.target.checked)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

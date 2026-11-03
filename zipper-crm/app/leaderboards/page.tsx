'use client'

/**
 * Leaderboards & rewards (B8, 3 Nov 2026) — the Owner's page.
 *
 *   * Rankings: Top hosts (beans earned from gifts and calls), Top supporters (diamonds spent on gifts) and Lucky
 *     gifters (off until lucky gifts are) — daily, weekly and monthly, cut at midnight IST. Scores are written by
 *     the money functions only; this page reads them.
 *   * Rewards: `appConfig/leaderboards` — per board and period, reward tiers by rank. Paid once, at 00:15 IST after a
 *     period closes (functions/src/leaderboards.ts). What is saved is what `mergeLeaderboardsConfig` makes of the
 *     form — the same cleaning the server applies — and a form with problems is not saved.
 *   * Settlements: who was paid what (`leaderboardSettlements`, Owner and Finance read).
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { collection, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore'
import { AlertTriangle, CheckCircle, Loader2, Plus, Save, Trash2, Trophy } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import {
  BOARD_IDS, BOARD_LABELS, PERIODS, type BoardId, type LeaderboardsConfig, type Period, type Tier,
  leaderboardsProblems, mergeLeaderboardsConfig, periodCost,
} from '@/lib/leaderboardsGuard'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-2 py-1 text-white text-sm focus:outline-none focus:border-pink-500'
const IST_MS = 330 * 60 * 1000

/** The IST keys the functions use: `2026-11-03`, `2026-W45`, `2026-11`. */
function currentKeys(now = new Date()): Record<Period, string> {
  const ist = new Date(now.getTime() + IST_MS)
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const isoYear = d.getUTCFullYear()
  const week = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7)
  return {
    daily: ist.toISOString().slice(0, 10),
    weekly: `${isoYear}-W${String(week).padStart(2, '0')}`,
    monthly: ist.toISOString().slice(0, 7),
  }
}

interface Standing { uid: string; name: string; score: number }
interface Settlement { id: string; board: string; period: string; periodKey: string; total: number; currency: string; winners: Array<{ rank: number; name?: string; uid: string; amount: number; skipped?: string }> }

export default function LeaderboardsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [cfg, setCfg] = useState<LeaderboardsConfig | null>(null)
  const [period, setPeriod] = useState<Period>('weekly')
  const [standings, setStandings] = useState<Record<string, Standing[]>>({})
  const [settlements, setSettlements] = useState<Settlement[]>([])
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    const snap = await getDoc(doc(db, 'appConfig', 'leaderboards'))
    setCfg(mergeLeaderboardsConfig(snap.exists() ? snap.data() : undefined))
    const keys = currentKeys()
    const next: Record<string, Standing[]> = {}
    for (const b of BOARD_IDS) {
      for (const p of PERIODS) {
        try {
          const q = query(collection(db, 'leaderboards', `${b}_${p}_${keys[p]}`, 'entries'), orderBy('score', 'desc'), limit(10))
          const rows = await getDocs(q)
          next[`${b}_${p}`] = rows.docs.map((d) => ({ uid: d.id, name: String(d.get('name') ?? ''), score: Number(d.get('score') ?? 0) }))
        } catch { next[`${b}_${p}`] = [] }
      }
    }
    setStandings(next)
    try {
      const rows = await getDocs(query(collection(db, 'leaderboardSettlements'), orderBy('settledAt', 'desc'), limit(20)))
      setSettlements(rows.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Settlement, 'id'>) })))
    } catch { setSettlements([]) }
  }, [])

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    load().catch(() => setNotice({ ok: false, msg: 'Could not load the leaderboards.' }))
  }, [crmUser, allowed, router, load])

  function setTiers(b: BoardId, p: Period, tiers: Tier[]) {
    setCfg((c) => (c ? { ...c, boards: { ...c.boards, [b]: { ...c.boards[b], [p]: { ...c.boards[b][p], tiers } } } } : c))
  }

  async function save() {
    if (!cfg) return
    const draft = Object.fromEntries(BOARD_IDS.map((b) => [b, Object.fromEntries(PERIODS.map((p) => [p, cfg.boards[b][p].tiers]))])) as Record<BoardId, Record<Period, Tier[]>>
    const problems = leaderboardsProblems(draft)
    if (problems.length) { setNotice({ ok: false, msg: problems.join(' ') }); return }
    const clean = mergeLeaderboardsConfig(cfg)
    setSaving(true)
    try {
      await setDoc(doc(db, 'appConfig', 'leaderboards'), { ...clean, updatedAt: serverTimestamp(), updatedBy: crmUser?.uid ?? '' })
      setNotice({ ok: true, msg: 'Saved. Rewards are paid at 00:15 IST after each period closes.' })
      await load()
    } catch {
      setNotice({ ok: false, msg: 'Save failed — only the Owner may change rewards.' })
    } finally { setSaving(false) }
  }

  if (!allowed) return <div className="flex items-center justify-center min-h-64"><p className="text-slate-400">Access denied.</p></div>
  if (!cfg) return <div className="flex items-center justify-center py-32"><Loader2 size={28} className="text-pink-500 animate-spin" /></div>

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2"><Trophy size={22} /> Leaderboards & rewards</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">
            Rankings are counted by the server where the money moves — gifts and calls — never by the app. Rewards are
            paid once, at 00:15 IST after a day, week (Monday) or month (the 1st) closes. Banned or suspended accounts
            are skipped; their reward is not passed down.
          </p>
        </div>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {notice.msg}
        </div>
      )}

      <label className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <span className="text-white font-medium">Rankings on (master switch)</span>
        <span className="text-slate-400 text-xs">Off hides every ranking in the app and pays no reward.</span>
      </label>

      <div className="flex gap-2">
        {PERIODS.map((p) => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`px-3 py-1 rounded-full text-sm ${period === p ? 'bg-pink-600 text-white' : 'bg-slate-800 text-slate-300'}`}>{p}</button>
        ))}
      </div>

      {BOARD_IDS.map((b) => {
        const bc = cfg.boards[b]
        const pr = bc[period]
        const top = standings[`${b}_${period}`] ?? []
        return (
          <div key={b} className="bg-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-white font-semibold">{BOARD_LABELS[b]}</h2>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={bc.enabled}
                  onChange={(e) => setCfg({ ...cfg, boards: { ...cfg.boards, [b]: { ...bc, enabled: e.target.checked } } })} /> On
              </label>
            </div>
            {b === 'lucky' && <p className="text-xs text-amber-300">Lucky gifts are switched off, so this board stays empty until they are switched on.</p>}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-xs text-slate-400">Rewards for each {period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month'}</p>
                {pr.tiers.map((t, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_1.4fr_auto] gap-2 items-center">
                    <input className={inputCls} type="number" value={t.from} title="From rank"
                      onChange={(e) => setTiers(b, period, pr.tiers.map((x, k) => (k === i ? { ...x, from: Number(e.target.value) } : x)))} />
                    <input className={inputCls} type="number" value={t.to} title="To rank"
                      onChange={(e) => setTiers(b, period, pr.tiers.map((x, k) => (k === i ? { ...x, to: Number(e.target.value) } : x)))} />
                    <input className={inputCls} type="number" value={t.amount} title="Amount each"
                      onChange={(e) => setTiers(b, period, pr.tiers.map((x, k) => (k === i ? { ...x, amount: Number(e.target.value) } : x)))} />
                    <button onClick={() => setTiers(b, period, pr.tiers.filter((_, k) => k !== i))} className="text-slate-400 hover:text-red-300"><Trash2 size={14} /></button>
                  </div>
                ))}
                <div className="flex items-center gap-3">
                  <button onClick={() => {
                    const last = pr.tiers.length ? Math.max(...pr.tiers.map((x) => x.to)) : 0
                    setTiers(b, period, [...pr.tiers, { from: last + 1, to: last + 1, amount: 100 }])
                  }} className="flex items-center gap-1 text-sm text-pink-300 hover:text-pink-200"><Plus size={14} /> Add tier</button>
                  {b === 'hosts' && (
                    <select className="bg-slate-700 text-white text-sm rounded px-2 py-1" value={pr.currency}
                      onChange={(e) => setCfg({ ...cfg, boards: { ...cfg.boards, hosts: { ...bc, [period]: { ...pr, currency: e.target.value as 'diamonds' | 'beans' } } } })}>
                      <option value="diamonds">paid in diamonds</option>
                      <option value="beans">paid in beans</option>
                    </select>
                  )}
                </div>
                <p className="text-xs text-slate-400">
                  {pr.tiers.length ? `Up to ${periodCost(pr.tiers).toLocaleString('en-IN')} ${pr.currency} per ${period === 'daily' ? 'day' : period === 'weekly' ? 'week' : 'month'} if every rewarded rank is filled.` : 'No rewards — the ranking is shown, nothing is paid.'}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-1">Standing now (top 10)</p>
                {top.length === 0 ? <p className="text-slate-500 text-sm">Nobody yet.</p> : (
                  <ol className="text-sm text-slate-300 space-y-0.5">
                    {top.map((s, i) => <li key={s.uid}>#{i + 1} {s.name || s.uid} — {s.score.toLocaleString('en-IN')}</li>)}
                  </ol>
                )}
              </div>
            </div>
          </div>
        )
      })}

      <div className="bg-slate-800 rounded-xl p-4">
        <h2 className="text-white font-semibold mb-2">Recent settlements</h2>
        {settlements.length === 0 ? <p className="text-slate-400 text-sm">None yet.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Period</th><th>Board</th><th>Paid</th><th>Total</th><th className="text-left">Winners</th></tr></thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.id} className="align-top">
                  <td>{s.period} {s.periodKey}</td>
                  <td className="text-center">{s.board}</td>
                  <td className="text-center">{(s.winners ?? []).filter((w) => w.amount > 0).length}</td>
                  <td className="text-center">{Number(s.total ?? 0).toLocaleString('en-IN')} {s.currency}</td>
                  <td className="text-xs">{(s.winners ?? []).slice(0, 5).map((w) => `#${w.rank} ${w.name || w.uid}${w.skipped ? ` (skipped: ${w.skipped})` : ` ${w.amount}`}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

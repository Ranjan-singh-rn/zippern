'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import {
  getUserLevels, saveUserLevel, getHostLevels, saveHostLevel,
  DEFAULT_USER_LEVELS, DEFAULT_HOST_LEVELS,
  type UserLevelConfig, type HostLevelConfig,
} from '@/lib/appConfig'
import { Loader2, Save, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'

function Toast({ msg, type }: { msg: string; type: 'ok'|'err' }) {
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

// ── How levels work info box ──────────────────────────────────────────────────

function HowItWorks({ type }: { type: 'user' | 'host' }) {
  return (
    <div className="mb-5 grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
      <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-300 mb-2">
          {type === 'user' ? '👤 How User Level increases' : '🎙️ How Host Level increases'}
        </p>
        {type === 'user' ? (
          <ul className="space-y-1 text-xs text-slate-400">
            <li><span className="text-white font-medium">Calls</span> → 100% of diamonds spent</li>
            <li><span className="text-white font-medium">Normal / Special Gifts</span> → 100% of diamonds spent</li>
            <li><span className="text-white font-medium">Lucky Gifts &amp; Games</span> → 1% of diamonds spent</li>
            <li className="text-slate-500 pt-1">Tracked in <code className="text-pink-400">users/{'{uid}'}.totalXp</code></li>
          </ul>
        ) : (
          <ul className="space-y-1 text-xs text-slate-400">
            <li><span className="text-white font-medium">All beans earned</span> from calls &amp; gifts count</li>
            <li><span className="text-white font-medium">Withdrawals don't reset</span> progress — cumulative only</li>
            <li className="text-slate-500 pt-1">Tracked in <code className="text-purple-400">users/{'{uid}'}.totalBeansEarned</code></li>
          </ul>
        )}
      </div>
      <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
        <p className="text-xs font-semibold text-slate-300 mb-2">📋 Fields explained</p>
        <ul className="space-y-1 text-xs text-slate-400">
          <li><span className="text-white font-medium">{type === 'user' ? 'XP Required' : 'Beans Required'}</span> — cumulative total needed to reach this level</li>
          <li><span className="text-white font-medium">Bonus {type === 'user' ? '💎' : '🫘 / 💎'}</span> — one-time reward given when the user hits this level</li>
          <li className="text-slate-500 pt-1">Frame, entrance, and profile card unlocks are managed in <span className="text-slate-400">Tech → Bag Items</span></li>
        </ul>
      </div>
    </div>
  )
}

// ── User Levels tab ───────────────────────────────────────────────────────────

function UserLevelsTab({ showToast }: { showToast: (m: string, t: 'ok'|'err') => void }) {
  const [levels, setLevels] = useState<UserLevelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<number, boolean>>({})

  useEffect(() => {
    getUserLevels()
      .then(data => {
        // Merge Firestore data with defaults (same pattern as packages page)
        const fsMap = new Map(data.map(l => [l.level, l]))
        const merged = DEFAULT_USER_LEVELS.map(d => fsMap.get(d.level) ?? d)
        setLevels(merged)
      })
      .catch(() => setLevels(DEFAULT_USER_LEVELS))
      .finally(() => setLoading(false))
  }, [])

  async function seedAll() {
    try {
      await Promise.all(DEFAULT_USER_LEVELS.map(l => saveUserLevel(l)))
      setLevels(DEFAULT_USER_LEVELS)
      showToast('Seeded all 21 user levels', 'ok')
    } catch { showToast('Seed failed', 'err') }
  }

  async function save(lvl: UserLevelConfig) {
    setSaving(s => ({ ...s, [lvl.level]: true }))
    try { await saveUserLevel(lvl); showToast(`Level ${lvl.level} saved`, 'ok') }
    catch { showToast('Save failed', 'err') }
    finally { setSaving(s => ({ ...s, [lvl.level]: false })) }
  }

  function patch(level: number, field: keyof UserLevelConfig, val: string | number) {
    setLevels(ls => ls.map(l => l.level === level ? { ...l, [field]: val } : l))
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-pink-500" /></div>

  return (
    <div>
      <HowItWorks type="user" />

      <div className="flex items-center justify-between mb-3">
        <p className="text-slate-400 text-xs">Levels 0–20 · XP = cumulative diamonds spent · Level 0 = starting state, no threshold</p>
        <button onClick={seedAll}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs transition-colors">
          <RefreshCw size={12} />Reset All to Defaults
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-700/50 text-slate-300 text-xs">
              <th className="px-4 py-2.5 text-left font-semibold w-16">Lvl</th>
              <th className="px-4 py-2.5 text-left font-semibold">XP Required (💎 spent)</th>
              <th className="px-4 py-2.5 text-left font-semibold">Bonus 💎 on level-up</th>
              <th className="px-4 py-2.5 text-left font-semibold">Max call rate 🫘/min</th>
              <th className="px-4 py-2.5 text-right w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {levels.map(lvl => (
              <tr key={lvl.level} className={`hover:bg-slate-700/20 ${lvl.level === 0 ? 'opacity-60' : ''}`}>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                    lvl.level === 20 ? 'bg-yellow-500/20 text-yellow-300' :
                    lvl.level >= 16 ? 'bg-pink-500/20 text-pink-300' :
                    lvl.level >= 11 ? 'bg-purple-500/20 text-purple-300' :
                    lvl.level >= 7  ? 'bg-blue-500/20 text-blue-300' :
                    'bg-slate-600/50 text-slate-300'
                  }`}>
                    {lvl.level}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {lvl.level === 0
                    ? <span className="text-slate-500 text-xs">— starting level</span>
                    : <input type="number" value={lvl.xpRequired} onChange={e => patch(lvl.level, 'xpRequired', +e.target.value)} className={inputCls} />
                  }
                </td>
                <td className="px-4 py-2">
                  <input type="number" value={lvl.bonusDiamonds} onChange={e => patch(lvl.level, 'bonusDiamonds', +e.target.value)} className={inputCls} />
                </td>
                <td className="px-4 py-2 text-right w-20">
                  <button onClick={() => save(lvl)} disabled={!!saving[lvl.level]}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
                    {saving[lvl.level] ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Host Levels tab ───────────────────────────────────────────────────────────

function HostLevelsTab({ showToast }: { showToast: (m: string, t: 'ok'|'err') => void }) {
  const [levels, setLevels] = useState<HostLevelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<Record<number, boolean>>({})

  useEffect(() => {
    getHostLevels()
      .then(data => {
        const fsMap = new Map(data.map(l => [l.level, l]))
        const merged = DEFAULT_HOST_LEVELS.map(d => fsMap.get(d.level) ?? d)
        setLevels(merged)
      })
      .catch(() => setLevels(DEFAULT_HOST_LEVELS))
      .finally(() => setLoading(false))
  }, [])

  async function seedAll() {
    try {
      await Promise.all(DEFAULT_HOST_LEVELS.map(l => saveHostLevel(l)))
      setLevels(DEFAULT_HOST_LEVELS)
      showToast('Seeded all 11 host levels', 'ok')
    } catch { showToast('Seed failed', 'err') }
  }

  async function save(lvl: HostLevelConfig) {
    setSaving(s => ({ ...s, [lvl.level]: true }))
    try { await saveHostLevel(lvl); showToast(`Host level ${lvl.level} saved`, 'ok') }
    catch { showToast('Save failed', 'err') }
    finally { setSaving(s => ({ ...s, [lvl.level]: false })) }
  }

  function patch(level: number, field: keyof HostLevelConfig, val: string | number) {
    setLevels(ls => ls.map(l => l.level === level ? { ...l, [field]: val } : l))
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-pink-500" /></div>

  return (
    <div>
      <HowItWorks type="host" />

      <div className="flex items-center justify-between mb-3">
        <p className="text-slate-400 text-xs">Levels 0–10 · Based on cumulative beans earned · Level 0 = starting state</p>
        <button onClick={seedAll}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs transition-colors">
          <RefreshCw size={12} />Reset All to Defaults
        </button>
      </div>

      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-700/50 text-slate-300 text-xs">
              <th className="px-4 py-2.5 text-left font-semibold w-16">Lvl</th>
              <th className="px-4 py-2.5 text-left font-semibold">Beans Required 🫘</th>
              <th className="px-4 py-2.5 text-left font-semibold">Bonus Beans 🫘 on level-up</th>
              <th className="px-4 py-2.5 text-left font-semibold">Bonus 💎 on level-up</th>
              <th className="px-4 py-2.5 text-right w-20" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {levels.map(lvl => (
              <tr key={lvl.level} className={`hover:bg-slate-700/20 ${lvl.level === 0 ? 'opacity-60' : ''}`}>
                <td className="px-4 py-2">
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                    lvl.level === 10 ? 'bg-yellow-500/20 text-yellow-300' :
                    lvl.level >= 7  ? 'bg-purple-500/20 text-purple-300' :
                    lvl.level >= 4  ? 'bg-green-500/20 text-green-300' :
                    'bg-slate-600/50 text-slate-300'
                  }`}>
                    {lvl.level}
                  </span>
                </td>
                <td className="px-4 py-2">
                  {lvl.level === 0
                    ? <span className="text-slate-500 text-xs">— starting level</span>
                    : <input type="number" value={lvl.beansRequired} onChange={e => patch(lvl.level, 'beansRequired', +e.target.value)} className={inputCls} />
                  }
                </td>
                <td className="px-4 py-2">
                  <input type="number" value={lvl.bonusBeans} onChange={e => patch(lvl.level, 'bonusBeans', +e.target.value)} className={inputCls} />
                </td>
                <td className="px-4 py-2">
                  <input type="number" value={lvl.bonusDiamonds} onChange={e => patch(lvl.level, 'bonusDiamonds', +e.target.value)} className={inputCls} />
                </td>
                <td className="px-4 py-2">
                  {/* The ceiling a host at this level may set. Read by getHostHome
                      and the app's rate slider. 700 at level 0, 2400 at level 10;
                      the agency band (Economy Config) must not exceed level 0. */}
                  <input type="number" min={1} step={50} value={lvl.maxCallRateBeans ?? 0}
                    onChange={e => patch(lvl.level, 'maxCallRateBeans', +e.target.value)} className={inputCls} />
                </td>
                <td className="px-4 py-2 text-right w-20">
                  <button onClick={() => save(lvl)} disabled={!!saving[lvl.level]}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-colors">
                    {saving[lvl.level] ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'user' | 'host'

export default function LevelsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('user')
  const [toast, setToast] = useState<{ msg: string; type: 'ok'|'err' } | null>(null)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
  }, [crmUser, router])

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

  return (
    <div className="max-w-full mx-auto">
      {toast && <Toast msg={toast.msg} type={toast.type} />}

      <h1 className="text-2xl font-bold text-white mb-1">Level Config</h1>
      <p className="text-slate-400 text-sm mb-6">XP thresholds, cosmetic unlocks, and bonus rewards for each level. Saved to Firestore — app reads dynamically.</p>

      <div className="flex gap-1 mb-6 bg-slate-900 border border-slate-800 rounded-xl p-1 w-fit">
        <button onClick={() => setTab('user')}
          className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'user' ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'
          }`}>
          👤 User Levels (0–20)
        </button>
        <button onClick={() => setTab('host')}
          className={`px-5 py-2 rounded-lg text-sm font-semibold transition-colors ${
            tab === 'host' ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'
          }`}>
          🎙️ Host Levels (0–10)
        </button>
      </div>

      {tab === 'user' && <UserLevelsTab showToast={showToast} />}
      {tab === 'host' && <HostLevelsTab showToast={showToast} />}
    </div>
  )
}

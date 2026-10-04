'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getDailyRewards, saveDailyRewards, DEFAULT_DAILY_REWARDS, type DayReward } from '@/lib/appConfig'
import { Loader2, Save, CheckCircle, AlertTriangle, RefreshCw } from 'lucide-react'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'

const DAY_LABELS = ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7']

export default function DailyRewardsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const [schedule, setSchedule] = useState<DayReward[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok'|'err' } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
    getDailyRewards()
      .then(data => setSchedule(data.length > 0 ? data : DEFAULT_DAILY_REWARDS))
      .catch(err => {
        console.error(err)
        setSchedule(DEFAULT_DAILY_REWARDS)
        setLoadError('Failed to load daily rewards — showing defaults.')
      })
      .finally(() => setLoading(false))
  }, [crmUser, router])

  function showToast(msg: string, type: 'ok'|'err') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  function patch(day: number, field: keyof DayReward, val: number) {
    setSchedule(s => s.map(r => r.day === day ? { ...r, [field]: val } : r))
  }

  async function handleSave() {
    setSaving(true)
    try {
      await saveDailyRewards(schedule)
      showToast('Daily rewards saved', 'ok')
    } catch { showToast('Save failed', 'err') }
    finally { setSaving(false) }
  }

  function seedDefaults() {
    setSchedule(DEFAULT_DAILY_REWARDS)
    showToast('Loaded defaults (not saved yet)', 'ok')
  }

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <Loader2 size={28} className="text-pink-500 animate-spin" />
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto">
      {loadError && (
        <div className="mb-4 flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle size={14} />
          {loadError}
        </div>
      )}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border ${
          toast.type === 'ok'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {toast.type === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          {toast.msg}
        </div>
      )}

      <h1 className="text-2xl font-bold text-white mb-1">Daily Rewards</h1>
      <p className="text-slate-400 text-sm mb-6">7-day login streak rewards. Users get diamonds and video call cards for consecutive daily logins. Resets if they miss a day.</p>

      <div className="space-y-3 mb-6">
        {schedule.map((reward, i) => (
          <div key={reward.day}
            className="flex flex-wrap items-center gap-4 bg-slate-800 border border-slate-700 rounded-xl px-5 py-4">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${
              i === 6 ? 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30' : 'bg-slate-700 text-slate-300'
            }`}>
              {i + 1}
            </div>
            <div className="flex-1">
              <p className="text-white text-sm font-semibold">{DAY_LABELS[i]}</p>
              {i === 6 && <p className="text-yellow-400/80 text-xs mt-0.5">Final day — bonus reward</p>}
            </div>
            <div className="flex items-center gap-3">
              <div>
                <label className="block text-slate-500 text-xs mb-1">💎 Diamonds</label>
                <input
                  type="number"
                  min={0}
                  value={reward.diamonds}
                  onChange={e => patch(reward.day, 'diamonds', +e.target.value)}
                  className={inputCls + ' w-24'}
                />
              </div>
              <div>
                <label className="block text-slate-500 text-xs mb-1">📞 Call Cards</label>
                <input
                  type="number"
                  min={0}
                  value={reward.callCards}
                  onChange={e => patch(reward.day, 'callCards', +e.target.value)}
                  className={inputCls + ' w-24'}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Schedule
        </button>
        <button onClick={seedDefaults}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl text-sm transition-colors">
          <RefreshCw size={13} />Reset to Defaults
        </button>
      </div>

      <div className="mt-6 bg-slate-800/50 border border-slate-700 rounded-xl px-5 py-4 text-sm text-slate-400">
        <p className="font-semibold text-slate-300 mb-1.5">Totals</p>
        <div className="flex gap-6">
          <span>💎 Total diamonds: <span className="text-white font-semibold">{schedule.reduce((a, r) => a + r.diamonds, 0)}</span></span>
          <span>📞 Total call cards: <span className="text-white font-semibold">{schedule.reduce((a, r) => a + r.callCards, 0)}</span></span>
        </div>
      </div>
    </div>
  )
}

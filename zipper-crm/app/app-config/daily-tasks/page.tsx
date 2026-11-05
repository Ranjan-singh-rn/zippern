'use client'

/**
 * Daily tasks (O8, Owner, 5 Nov 2026) — tasks for users and hosts, each paying diamonds (or beans, for a host task)
 * once a day when done. Saved to `appConfig/dailyTasks`, which only an MFA-bound Owner may write (firestore.rules);
 * the server measures progress from its own records (functions/src/dailyTasks.ts) and sanitises the list again.
 * Every claim is a ledger row and a `promoCredits` row: Reports → Promotions and "Daily rewards & tasks" show them.
 */

import { useCallback, useEffect, useState } from 'react'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { AlertTriangle, CheckCircle, ListChecks, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { Denied, Loading } from '@/components/ui/States'
import {
  DAILY_TASK_METRICS, DAILY_TASKS_LIMITS, METRIC_IDS, droppedOnSave, sanitizeDailyTasks, taskIdFrom,
  type DailyTask, type DailyTaskAudience, type DailyTaskMetric,
} from '@/lib/dailyTasksSettings'

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-pink-500'

export default function DailyTasksPage() {
  const { crmUser, loading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [enabled, setEnabled] = useState(false)
  const [tasks, setTasks] = useState<DailyTask[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    const snap = await getDoc(doc(db, 'appConfig', 'dailyTasks'))
    const c = sanitizeDailyTasks(snap.exists() ? snap.data() : undefined)
    setEnabled(c.enabled)
    setTasks(c.tasks)
  }, [])

  useEffect(() => { if (allowed) void load().catch((e) => setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Could not read the settings.' })) }, [allowed, load])

  if (loading) return <Loading />
  if (!allowed) return <Denied what="daily tasks" />
  if (!tasks) return <Loading />

  const set = (i: number, patch: Partial<DailyTask>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const add = () => {
    if (tasks.length >= DAILY_TASKS_LIMITS.maxTasks) return
    const title = 'Send 5 gifts'
    setTasks([...tasks, { id: taskIdFrom(title, new Set(tasks.map((t) => t.id))), title, audience: 'everyone', metric: 'send_gifts', target: 5, rewardDiamonds: 10, rewardBeans: 0, enabled: true, order: tasks.length }])
  }

  async function save() {
    if (!tasks) return
    setSaving(true)
    setNotice(null)
    try {
      const dropped = droppedOnSave(tasks as unknown as Record<string, unknown>[])
      const clean = sanitizeDailyTasks({ enabled, tasks })
      await setDoc(doc(db, 'appConfig', 'dailyTasks'), { ...clean, updatedAt: serverTimestamp(), updatedBy: crmUser?.uid ?? '' })
      setEnabled(clean.enabled)
      setTasks(clean.tasks)
      setNotice({ ok: true, msg: `Saved ${clean.tasks.length} task${clean.tasks.length === 1 ? '' : 's'}${dropped ? ` (${dropped} without a reward or with a bad entry were left out)` : ''}. Phones pick it up within a minute.` })
    } catch (e) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Could not save.' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2"><ListChecks size={20} className="text-pink-400" /> Daily tasks</h1>
        <p className="text-slate-400 text-sm mt-1">
          Tasks for users and hosts, reset every day at midnight IST. The server counts progress from its own records
          (gifts, calls, lives, party rooms, chats) and pays the reward once per task per day when the person taps Claim.
          Every reward is a ledger row and shows in Reports → Promotions and in Daily rewards &amp; tasks.
        </p>
      </div>

      <label className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-5 py-3 cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-pink-500" />
        <span className="text-white text-sm font-medium">Daily tasks are on (shown in the app and counted)</span>
      </label>

      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-slate-400 text-xs uppercase">
            <tr>
              <th className="text-left p-2">On</th><th className="text-left p-2">Title</th><th className="text-left p-2">Measure</th>
              <th className="text-left p-2">For</th><th className="text-left p-2">Target</th><th className="text-left p-2">💎 Reward</th>
              <th className="text-left p-2">Beans (hosts)</th><th className="text-left p-2">Order</th><th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((t, i) => {
              const def = DAILY_TASK_METRICS[t.metric]
              return (
                <tr key={t.id} className="border-t border-slate-800">
                  <td className="p-2"><input type="checkbox" checked={t.enabled} onChange={(e) => set(i, { enabled: e.target.checked })} className="accent-pink-500" /></td>
                  <td className="p-2 min-w-[180px]"><input className={inputCls} value={t.title} maxLength={DAILY_TASKS_LIMITS.titleMax} onChange={(e) => set(i, { title: e.target.value })} /></td>
                  <td className="p-2 min-w-[180px]">
                    <select className={inputCls} value={t.metric} onChange={(e) => {
                      const m = e.target.value as DailyTaskMetric
                      set(i, { metric: m, audience: DAILY_TASK_METRICS[m].hostsOnly ? 'hosts' : t.audience, target: m === 'daily_checkin' ? 1 : t.target })
                    }}>
                      {METRIC_IDS.map((m) => <option key={m} value={m}>{DAILY_TASK_METRICS[m].label}{DAILY_TASK_METRICS[m].hostsOnly ? ' (hosts)' : ''}</option>)}
                    </select>
                  </td>
                  <td className="p-2">
                    <select className={inputCls} value={t.audience} disabled={def.hostsOnly} onChange={(e) => set(i, { audience: e.target.value as DailyTaskAudience })}>
                      <option value="everyone">Everyone</option><option value="users">Users</option><option value="hosts">Hosts</option>
                    </select>
                  </td>
                  <td className="p-2 w-28"><input className={inputCls} type="number" min={1} max={def.maxTarget} disabled={t.metric === 'daily_checkin'} value={t.target} onChange={(e) => set(i, { target: Number(e.target.value) })} /><span className="text-slate-500 text-xs">{def.unit}</span></td>
                  <td className="p-2 w-24"><input className={inputCls} type="number" min={0} max={DAILY_TASKS_LIMITS.maxRewardDiamonds} value={t.rewardDiamonds} onChange={(e) => set(i, { rewardDiamonds: Number(e.target.value) })} /></td>
                  <td className="p-2 w-28"><input className={inputCls} type="number" min={0} max={DAILY_TASKS_LIMITS.maxRewardBeans} disabled={t.audience !== 'hosts'} value={t.rewardBeans} onChange={(e) => set(i, { rewardBeans: Number(e.target.value) })} /></td>
                  <td className="p-2 w-20"><input className={inputCls} type="number" value={t.order} onChange={(e) => set(i, { order: Number(e.target.value) })} /></td>
                  <td className="p-2"><button onClick={() => setTasks(tasks.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-400" aria-label={`Remove ${t.title}`}><Trash2 size={15} /></button></td>
                </tr>
              )
            })}
            {tasks.length === 0 && <tr><td colSpan={9} className="p-4 text-slate-500 text-center">No tasks yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <button onClick={add} disabled={tasks.length >= DAILY_TASKS_LIMITS.maxTasks} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg px-3 py-2 text-sm"><Plus size={15} /> Add a task</button>
        <button onClick={() => void save()} disabled={saving} className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-60 text-white font-semibold rounded-lg px-4 py-2 text-sm">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
        </button>
        <span className="text-slate-500 text-xs">Up to {DAILY_TASKS_LIMITS.maxTasks} tasks · at most {DAILY_TASKS_LIMITS.maxRewardDiamonds.toLocaleString('en-IN')} diamonds or {DAILY_TASKS_LIMITS.maxRewardBeans.toLocaleString('en-IN')} beans each.</span>
      </div>

      {notice && (
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2 border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} className="mt-0.5" /> : <AlertTriangle size={14} className="mt-0.5" />}
          <p className="text-sm">{notice.msg}</p>
        </div>
      )}
    </div>
  )
}

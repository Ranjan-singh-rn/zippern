/**
 * O8 (5 Nov 2026) — `appConfig/dailyTasks` as the CRM edits it: the same clamping as the server's
 * `sanitizeDailyTasksConfig` (functions/src/dailyTasks.ts), so the form never saves a task the server would drop or
 * change. Pure; tested by dailyTasksSettings.spec.ts. No imports, so the spec runs the shipped module standalone.
 */

export type DailyTaskAudience = 'everyone' | 'users' | 'hosts'
export type DailyTaskMetric =
  | 'daily_checkin' | 'send_gifts' | 'gift_diamonds' | 'call_minutes' | 'watch_live_minutes'
  | 'party_minutes' | 'party_joins' | 'dm_people'
  | 'live_minutes' | 'gifts_received' | 'beans_earned' | 'call_minutes_received'

export interface MetricDef { label: string; unit: string; hostsOnly: boolean; maxTarget: number }

/** What the server can measure — the same table as the server's DAILY_TASK_METRICS. */
export const DAILY_TASK_METRICS: Record<DailyTaskMetric, MetricDef> = {
  daily_checkin: { label: 'Claim your daily reward', unit: 'times', hostsOnly: false, maxTarget: 1 },
  send_gifts: { label: 'Send gifts', unit: 'gifts', hostsOnly: false, maxTarget: 10_000 },
  gift_diamonds: { label: 'Spend diamonds on gifts', unit: 'diamonds', hostsOnly: false, maxTarget: 10_000_000 },
  call_minutes: { label: 'Talk on paid calls', unit: 'minutes', hostsOnly: false, maxTarget: 1_440 },
  watch_live_minutes: { label: 'Watch lives', unit: 'minutes', hostsOnly: false, maxTarget: 1_440 },
  party_minutes: { label: 'Spend time in party rooms', unit: 'minutes', hostsOnly: false, maxTarget: 1_440 },
  party_joins: { label: 'Join party rooms', unit: 'rooms', hostsOnly: false, maxTarget: 100 },
  dm_people: { label: 'Chat with different people', unit: 'people', hostsOnly: false, maxTarget: 100 },
  live_minutes: { label: 'Go live', unit: 'minutes', hostsOnly: true, maxTarget: 1_440 },
  gifts_received: { label: 'Receive gifts', unit: 'gifts', hostsOnly: true, maxTarget: 100_000 },
  beans_earned: { label: 'Earn beans from gifts and calls', unit: 'beans', hostsOnly: true, maxTarget: 100_000_000 },
  call_minutes_received: { label: 'Take paid calls', unit: 'minutes', hostsOnly: true, maxTarget: 1_440 },
}
export const METRIC_IDS = Object.keys(DAILY_TASK_METRICS) as DailyTaskMetric[]

export interface DailyTask {
  id: string
  title: string
  audience: DailyTaskAudience
  metric: DailyTaskMetric
  target: number
  rewardDiamonds: number
  rewardBeans: number
  enabled: boolean
  order: number
}
export interface DailyTasksSettings { enabled: boolean; tasks: DailyTask[] }

/** The same numbers as the server's DAILY_TASKS_LIMITS. */
export const DAILY_TASKS_LIMITS = { maxTasks: 30, maxRewardDiamonds: 10_000, maxRewardBeans: 100_000, titleMax: 60 } as const
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

function whole(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/** A task id from a title: lower-case letters, digits, `-`; unique against `taken`. */
export function taskIdFrom(title: string, taken: Set<string>): string {
  const base = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'task')
  let id = /^[a-z0-9]/.test(base) ? base : `t${base}`
  let n = 2
  while (taken.has(id)) id = `${base.slice(0, 36)}-${n++}`
  return id
}

export function isMetric(m: unknown): m is DailyTaskMetric {
  return typeof m === 'string' && Object.prototype.hasOwnProperty.call(DAILY_TASK_METRICS, m)
}

export function sanitizeDailyTasks(raw: Record<string, unknown> | null | undefined): DailyTasksSettings {
  const r = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(r.tasks) ? (r.tasks as unknown[]) : []
  const seen = new Set<string>()
  const tasks: DailyTask[] = []
  list.forEach((t0, i) => {
    if (!t0 || typeof t0 !== 'object' || Array.isArray(t0)) return
    const t = t0 as Record<string, unknown>
    const id = String(t.id ?? '').trim().toLowerCase()
    if (!TASK_ID_RE.test(id) || seen.has(id)) return
    if (!isMetric(t.metric)) return
    const metric = t.metric
    const def = DAILY_TASK_METRICS[metric]
    const aud = String(t.audience ?? 'everyone')
    const audience: DailyTaskAudience = def.hostsOnly ? 'hosts' : (aud === 'users' || aud === 'hosts' ? aud : 'everyone')
    const target = metric === 'daily_checkin' ? 1 : whole(t.target, 1, def.maxTarget, 1)
    const rewardDiamonds = whole(t.rewardDiamonds, 0, DAILY_TASKS_LIMITS.maxRewardDiamonds, 0)
    const rewardBeans = audience === 'hosts' ? whole(t.rewardBeans, 0, DAILY_TASKS_LIMITS.maxRewardBeans, 0) : 0
    if (rewardDiamonds + rewardBeans <= 0) return
    const title = String(t.title ?? '').replace(/\s+/g, ' ').trim().slice(0, DAILY_TASKS_LIMITS.titleMax) || def.label
    seen.add(id)
    tasks.push({ id, title, audience, metric, target, rewardDiamonds, rewardBeans, enabled: t.enabled !== false, order: whole(t.order, -1_000, 1_000, i) })
  })
  tasks.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { enabled: r.enabled === true, tasks: tasks.slice(0, DAILY_TASKS_LIMITS.maxTasks) }
}

/** What the Owner may lose on save: tasks the server would drop (no reward, bad id, unknown measure). */
export function droppedOnSave(draft: Record<string, unknown>[]): number {
  return draft.length - sanitizeDailyTasks({ enabled: true, tasks: draft }).tasks.length
}

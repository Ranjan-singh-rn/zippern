/**
 * O8 (Owner, 5 Nov 2026) — daily tasks for users and hosts, and the audit trail of what they pay out.
 *
 *   "daily task daily. reward those should be consider for audit and in crm dashboard we should get the no."
 *
 * ── What the Owner sets (CRM → App Config → Daily tasks; `appConfig/dailyTasks`, the Owner's alone in the rules)
 *
 *   { enabled, tasks: [{ id, title, audience: everyone | users | hosts, metric, target,
 *                        rewardDiamonds, rewardBeans (host tasks only), enabled, order }] }
 *
 *   Sanitised here ([sanitizeDailyTasksConfig]) on every read, and by the CRM with the same limits before a save.
 *   A missing or malformed document is "off".
 *
 * ── What counts: only what the SERVER measures, from records it already writes ([DAILY_TASK_METRICS])
 *
 *   gift rows, call rows and the daily-reward row of `users/{uid}/diamondTransactions` → [dailyTasksDiamondLedger]
 *   gift rows and call rows of `users/{uid}/beanTransactions`                          → [dailyTasksBeanLedger]
 *   a live's server-measured length when it closes (profiles.syncLivePresence)         → [recordLiveMinutes]
 *   a viewer's presence row in a room that is live, once a minute (live.liveViewerCount) → [recordWatchMinute]
 *   a party heartbeat the server accepted (party.partyHeartbeat)                       → [recordPartyPresence]
 *   a direct message sent (safety.screenDirectMessage)                                 → [recordDirectMessage]
 *
 *   The money functions (settleGift, the call functions, joinPartyRoom) are not touched: the two triggers read the
 *   rows those functions already write inside their own transactions.
 *
 * ── Where progress lives
 *
 *   `users/{uid}/dailyTasks/{YYYY-MM-DD}` (the IST day) — one number per metric, plus `claimed`. Written only here;
 *   the person reads their own (firestore.rules). Every increment is exactly-once: it commits together with a
 *   marker `users/{uid}/dailyTaskSeen/{key}`, and is skipped when the marker already exists. The key is the
 *   trigger's event id for ledger rows (a redelivered event is the same event), the minute for presence (a minute
 *   counts once however often a phone writes), the room for a live's length and for a party joined, and the other
 *   person for "chat with N people". Nothing is recorded while the master switch is off, or for a metric no enabled
 *   task uses — so a quiet config costs one cached read.
 *
 * ── Claiming ([claimDailyTask])
 *
 *   Signed in, on the active session, not restricted, and the Owner's verified-contact lever exactly as for the daily
 *   reward; the task on and meant for this person (a suspended Host claims no host task); today's progress at or past
 *   the target; once per task per IST day. ONE transaction: the wallet, the history row (diamonds; and beans for a
 *   host task), `promoCredits/task_{uid}_{date}_{taskId}` (kind `daily_task` — what the CRM's dashboard, the
 *   promotions report and the audit page read) and the `claimed` mark the app shows. The promotion document's id is
 *   deterministic, so a replayed claim can never pay twice.
 */

import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { istDateKey } from './time'
import { assertActiveSession, restrictionVerdict, ACCOUNT_RESTRICTED } from './mobileSession'
import { guestRefusal, hostRoleSuspension, hostSuspendedMessage, hostSuspensionDetails } from './hostEligibility'
import { dailyRewardRequiresVerifiedContact, VERIFIED_CONTACT_REQUIRED } from './wallet'

const db = (): admin.firestore.Firestore => admin.firestore()
const REGION = 'asia-south1'

// ══════════════════════════════════════════════════════════════════════════════
//  The configuration
// ══════════════════════════════════════════════════════════════════════════════

export type DailyTaskMetric =
  | 'daily_checkin' | 'send_gifts' | 'gift_diamonds' | 'call_minutes' | 'watch_live_minutes'
  | 'party_minutes' | 'party_joins' | 'dm_people'
  | 'live_minutes' | 'gifts_received' | 'beans_earned' | 'call_minutes_received'

export interface MetricDef { label: string; unit: string; hostsOnly: boolean; maxTarget: number }

/** Everything a task can measure. `hostsOnly` metrics make a task the hosts' whatever the CRM sent. */
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

export function isDailyTaskMetric(m: unknown): m is DailyTaskMetric {
  return typeof m === 'string' && Object.prototype.hasOwnProperty.call(DAILY_TASK_METRICS, m)
}

export type DailyTaskAudience = 'everyone' | 'users' | 'hosts'

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

export interface DailyTasksConfig { enabled: boolean; tasks: DailyTask[] }

/** The same numbers as the CRM's `lib/dailyTasksSettings.ts`. */
export const DAILY_TASKS_LIMITS = {
  maxTasks: 30,
  maxRewardDiamonds: 10_000,
  maxRewardBeans: 100_000,
  titleMax: 60,
} as const

const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

function whole(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * Pure — what the server will act on. Drops what it cannot use (unknown metric, bad or repeated id, no reward),
 * clamps every number, makes a host metric's task the hosts', and orders by `order` then id. Off unless
 * `enabled === true`.
 */
export function sanitizeDailyTasksConfig(raw: Record<string, unknown> | null | undefined): DailyTasksConfig {
  const r = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(r.tasks) ? (r.tasks as unknown[]) : []
  const seen = new Set<string>()
  const tasks: DailyTask[] = []
  list.forEach((t0, i) => {
    if (!t0 || typeof t0 !== 'object' || Array.isArray(t0)) return
    const t = t0 as Record<string, unknown>
    const id = String(t.id ?? '').trim().toLowerCase()
    if (!TASK_ID_RE.test(id) || seen.has(id)) return
    if (!isDailyTaskMetric(t.metric)) return
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
    tasks.push({
      id, title, audience, metric, target, rewardDiamonds, rewardBeans,
      enabled: t.enabled !== false,
      order: whole(t.order, -1_000, 1_000, i),
    })
  })
  tasks.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { enabled: r.enabled === true, tasks: tasks.slice(0, DAILY_TASKS_LIMITS.maxTasks) }
}

/** Pure — is this task meant for this person. */
export function audienceMatches(audience: DailyTaskAudience, isHost: boolean): boolean {
  if (audience === 'hosts') return isHost
  if (audience === 'users') return !isHost
  return true
}

/** Pure — the metrics at least one switched-on task uses (none while the master switch is off). */
export function activeMetrics(cfg: DailyTasksConfig): Set<DailyTaskMetric> {
  const out = new Set<DailyTaskMetric>()
  if (!cfg.enabled) return out
  for (const t of cfg.tasks) if (t.enabled) out.add(t.metric)
  return out
}

let cached: { at: number; cfg: DailyTasksConfig } | null = null
const CACHE_MS = 60_000

/** The Owner's settings, read at most once a minute per instance. */
export async function dailyTasksConfig(): Promise<DailyTasksConfig> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.cfg
  const snap = await db().collection('appConfig').doc('dailyTasks').get()
  const cfg = sanitizeDailyTasksConfig(snap.exists ? (snap.data() as Record<string, unknown>) : undefined)
  cached = { at: now, cfg }
  return cfg
}

/** Tests only. */
export function _resetDailyTasksCache(): void { cached = null }

// ══════════════════════════════════════════════════════════════════════════════
//  Recording progress
// ══════════════════════════════════════════════════════════════════════════════

export type Contributions = Partial<Record<DailyTaskMetric, number>>

/** How long a marker is useful: well past the end of the IST day it belongs to (a TTL policy may sweep it). */
const MARKER_TTL_MS = 3 * 24 * 60 * 60 * 1000

/** A document id from a marker key: no slashes, bounded. */
export function markerId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300)
}

/**
 * Add to today's progress — exactly once per [key]. Returns whether anything was written. Only metrics an enabled
 * task uses are written; whole positive numbers only.
 */
export async function recordProgress(uid: string, add: Contributions, key: string, at: Date = new Date()): Promise<boolean> {
  if (!uid || !key) return false
  const cfg = await dailyTasksConfig()
  const used = activeMetrics(cfg)
  if (used.size === 0) return false
  const incs: Record<string, admin.firestore.FieldValue> = {}
  for (const [metric, n] of Object.entries(add)) {
    const v = Math.trunc(Number(n))
    if (used.has(metric as DailyTaskMetric) && Number.isFinite(v) && v > 0) {
      incs[metric] = admin.firestore.FieldValue.increment(v)
    }
  }
  if (Object.keys(incs).length === 0) return false
  const dateKey = istDateKey(at)
  const userRef = db().collection('users').doc(uid)
  const progressRef = userRef.collection('dailyTasks').doc(dateKey)
  const markerRef = userRef.collection('dailyTaskSeen').doc(markerId(key))
  const expireAt = admin.firestore.Timestamp.fromMillis(at.getTime() + MARKER_TTL_MS)
  return db().runTransaction(async (tx) => {
    const marker = await tx.get(markerRef)
    if (marker.exists) return false
    const now = admin.firestore.FieldValue.serverTimestamp()
    tx.set(markerRef, { dateKey, at: now, expireAt })
    tx.set(progressRef, { uid, dateKey, updatedAt: now, ...incs }, { merge: true })
    return true
  })
}

type Row = Record<string, unknown> | undefined
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Pure — what one write of a ledger row adds to the person's day.
 *
 * Gift rows are created once (settleGift); a call's row is one document per call, merged every billed minute with
 * the running `minutesBilled` (calls.ts), so its contribution is the change between `before` and `after`. The
 * daily-reward row is created once a day (claimDailyReward). Everything else in the ledgers (games, Party Pro,
 * ranking and task rewards, conversions) adds nothing — a task reward can never feed another task.
 */
export function ledgerContributions(ledger: 'diamond' | 'bean', before: Row, after: Row): Contributions {
  if (!after) return {}
  const reason = String(after.reason ?? '')
  const created = !before
  const out: Contributions = {}
  if (ledger === 'diamond') {
    if (reason === 'gift_sent' && created) {
      out.send_gifts = Math.max(1, Math.trunc(num(after.quantity)) || 1)
      const d = Math.trunc(num(after.amount))
      if (d > 0) out.gift_diamonds = d
    } else if (reason === 'video_call') {
      const m = Math.trunc(num(after.minutesBilled) - num(before?.minutesBilled))
      if (m > 0) out.call_minutes = m
    } else if (reason === 'daily_reward' && created) {
      out.daily_checkin = 1
    }
  } else {
    if (reason === 'gift_received' && created) {
      out.gifts_received = Math.max(1, Math.trunc(num(after.quantity)) || 1)
      const b = Math.trunc(num(after.amount))
      if (b > 0) out.beans_earned = b
    } else if (reason === 'video_call') {
      const m = Math.trunc(num(after.minutesBilled) - num(before?.minutesBilled))
      if (m > 0) out.call_minutes_received = m
      const b = Math.trunc(num(after.amount) - num(before?.amount))
      if (b > 0) out.beans_earned = b
    }
  }
  return out
}

interface TriggerContext { eventId?: string; timestamp?: string; params: Record<string, string> }

function eventTime(context: TriggerContext): Date {
  const t = context.timestamp ? Date.parse(context.timestamp) : Number.NaN
  return Number.isFinite(t) ? new Date(t) : new Date()
}

async function onLedgerWrite(
  ledger: 'diamond' | 'bean',
  change: functions.Change<functions.firestore.DocumentSnapshot>,
  context: TriggerContext,
): Promise<null> {
  const before = change.before?.exists ? (change.before.data() as Record<string, unknown>) : undefined
  const after = change.after?.exists ? (change.after.data() as Record<string, unknown>) : undefined
  const add = ledgerContributions(ledger, before, after)
  if (Object.keys(add).length === 0) return null
  const uid = String(context.params.uid ?? '')
  // A redelivered event carries the same id. Without one (never in production) the row's own state stands in.
  const key = context.eventId
    ? `ev_${context.eventId}`
    : `src_${ledger}_${context.params.txId}_${num(after?.minutesBilled)}_${num(after?.amount)}`
  try {
    await recordProgress(uid, add, key, eventTime(context))
  } catch (err) {
    functions.logger.warn('dailyTasks: ledger progress not recorded', { uid, ledger, err: String(err) })
  }
  return null
}

/** Gifts sent (count and diamonds), paid call minutes, the daily reward claimed. */
export const dailyTasksDiamondLedger = functions.region(REGION).firestore
  .document('users/{uid}/diamondTransactions/{txId}')
  .onWrite((change, context) => onLedgerWrite('diamond', change, context))

/** Gifts received, beans earned from gifts and calls, call minutes taken. */
export const dailyTasksBeanLedger = functions.region(REGION).firestore
  .document('users/{uid}/beanTransactions/{txId}')
  .onWrite((change, context) => onLedgerWrite('bean', change, context))

/** profiles.syncLivePresence, when a live closes: its server-measured length, once per room. */
export async function recordLiveMinutes(hostUid: string, roomId: string, seconds: number, at: Date = new Date()): Promise<boolean> {
  const minutes = Math.floor(Math.max(0, num(seconds)) / 60)
  if (!hostUid || !roomId || minutes <= 0) return false
  return recordProgress(hostUid, { live_minutes: minutes }, `lv_${roomId}`, at)
}

/** live.liveViewerCount: a viewer's presence row was written (the join, then once a minute) — in a room that is live. */
export async function recordWatchMinute(uid: string, roomId: string, at: Date = new Date()): Promise<boolean> {
  if (!uid || !roomId) return false
  const cfg = await dailyTasksConfig()
  if (!activeMetrics(cfg).has('watch_live_minutes')) return false
  const room = await db().collection('liveRooms').doc(roomId).get()
  if (!room.exists || room.get('isActive') !== true || room.get('hostUid') === uid) return false
  return recordProgress(uid, { watch_live_minutes: 1 }, `wm_${Math.floor(at.getTime() / 60_000)}`, at)
}

/** party.partyHeartbeat, after the server found the person in the room: the minute, and the room once a day. */
export async function recordPartyPresence(uid: string, roomId: string, at: Date = new Date()): Promise<void> {
  if (!uid || !roomId) return
  await recordProgress(uid, { party_minutes: 1 }, `pm_${Math.floor(at.getTime() / 60_000)}`, at)
  await recordProgress(uid, { party_joins: 1 }, `pj_${istDateKey(at)}_${roomId}`, at)
}

/** Pure — the other person in a `a_b` conversation id, or '' when the id is not that shape. */
export function peerFromConvoId(convoId: string, sender: string): string {
  const parts = String(convoId ?? '').split('_')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return ''
  if (parts[0] === sender) return parts[1]
  if (parts[1] === sender) return parts[0]
  return ''
}

/** safety.screenDirectMessage: a message somebody sent counts its other person, once a day. */
export async function recordDirectMessage(convoId: string, data: Record<string, unknown>, at: Date = new Date()): Promise<boolean> {
  const sender = String(data.senderUid ?? '')
  const type = String(data.type ?? 'text')
  if (!sender || !['text', 'image', 'voice'].includes(type)) return false
  const cfg = await dailyTasksConfig()
  if (!activeMetrics(cfg).has('dm_people')) return false
  let peer = peerFromConvoId(convoId, sender)
  if (!peer) {
    const convo = await db().collection('conversations').doc(convoId).get()
    const people = Array.isArray(convo.get('participants')) ? (convo.get('participants') as unknown[]).map(String) : []
    peer = people.find((p) => p && p !== sender) ?? ''
  }
  if (!peer || peer === sender) return false
  return recordProgress(sender, { dm_people: 1 }, `dm_${istDateKey(at)}_${peer}`, at)
}

// ══════════════════════════════════════════════════════════════════════════════
//  Claiming
// ══════════════════════════════════════════════════════════════════════════════

export const DAILY_TASKS_OFF = 'DAILY_TASKS_OFF'
export const DAILY_TASK_NOT_DONE = 'DAILY_TASK_NOT_DONE'

export const claimDailyTask = functions
  .region(REGION)
  .https.onCall(async (data: { taskId?: unknown }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')
    await assertActiveSession(uid, data, 'claimDailyTask', context.auth?.token)

    const taskId = String(data?.taskId ?? '').trim().toLowerCase()
    if (!TASK_ID_RE.test(taskId)) throw new functions.https.HttpsError('invalid-argument', 'taskId is required.')

    const today = istDateKey()
    const userRef = db().collection('users').doc(uid)
    const progressRef = userRef.collection('dailyTasks').doc(today)
    const cfgRef = db().collection('appConfig').doc('dailyTasks')
    const economyRef = db().collection('appConfig').doc('economy')
    const promoRef = db().collection('promoCredits').doc(`task_${uid}_${today}_${taskId}`)
    const token = context.auth?.token as Record<string, unknown> | undefined

    return db().runTransaction(async (tx) => {
      const [userSnap, progressSnap, cfgSnap, economySnap, promoSnap] = await Promise.all([
        tx.get(userRef), tx.get(progressRef), tx.get(cfgRef), tx.get(economyRef), tx.get(promoRef),
      ])
      if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')

      // The restriction state on the read that pays — as claimDailyReward.
      const restricted = restrictionVerdict((f) => userSnap.get(f))
      if (restricted) {
        throw new functions.https.HttpsError(
          'permission-denied',
          'This account is restricted and cannot claim rewards.',
          { code: ACCOUNT_RESTRICTED, state: restricted },
        )
      }
      // The Owner's lever for rewards: a verified contact when the economy config asks for one (M-22).
      if (dailyRewardRequiresVerifiedContact(economySnap.data() as Record<string, unknown> | undefined)
          && guestRefusal(token)) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'Add your phone number or email to claim rewards.',
          { code: VERIFIED_CONTACT_REQUIRED },
        )
      }

      const cfg = sanitizeDailyTasksConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
      if (!cfg.enabled) {
        throw new functions.https.HttpsError('failed-precondition', 'Daily tasks are not running right now.',
          { code: DAILY_TASKS_OFF })
      }
      const task = cfg.tasks.find((t) => t.id === taskId && t.enabled)
      if (!task) throw new functions.https.HttpsError('not-found', 'This task is not available today.')

      const isHost = userSnap.get('isHost') === true
      if (!audienceMatches(task.audience, isHost)) {
        throw new functions.https.HttpsError('permission-denied',
          task.audience === 'hosts' ? 'This task is for hosts.' : 'This task is not for hosts.')
      }
      if (task.audience === 'hosts') {
        const suspension = hostRoleSuspension(userSnap)
        if (suspension) {
          throw new functions.https.HttpsError('permission-denied', hostSuspendedMessage(suspension),
            hostSuspensionDetails(suspension))
        }
      }

      const progress = (progressSnap.exists ? progressSnap.data() : {}) as Record<string, unknown>
      const claimedRaw = progress.claimed
      const claimed = claimedRaw && typeof claimedRaw === 'object' && !Array.isArray(claimedRaw)
        ? (claimedRaw as Record<string, unknown>)
        : {}
      if (claimed[taskId] != null || promoSnap.exists) {
        throw new functions.https.HttpsError('already-exists', 'Already claimed today.')
      }
      const have = Math.max(0, Math.trunc(num(progress[task.metric])))
      if (have < task.target) {
        throw new functions.https.HttpsError('failed-precondition',
          `Not done yet: ${have} of ${task.target}.`, { code: DAILY_TASK_NOT_DONE, have, target: task.target })
      }

      const diamonds = task.rewardDiamonds
      const beans = task.audience === 'hosts' ? task.rewardBeans : 0
      const now = admin.firestore.FieldValue.serverTimestamp()
      const historyId = `task_${today}_${taskId}`
      const label = `Daily task — ${task.title}`

      const wallet: Record<string, admin.firestore.FieldValue> = {}
      if (diamonds > 0) wallet.diamonds = admin.firestore.FieldValue.increment(diamonds)
      if (beans > 0) wallet.beans = admin.firestore.FieldValue.increment(beans)
      if (Object.keys(wallet).length > 0) tx.update(userRef, wallet)

      const diamondRow = diamonds > 0 ? `users/${uid}/diamondTransactions/${historyId}` : null
      const beanRow = beans > 0 ? `users/${uid}/beanTransactions/${historyId}` : null
      if (diamonds > 0) {
        tx.set(userRef.collection('diamondTransactions').doc(historyId), {
          type: 'credit',
          amount: diamonds,
          balanceAfter: num(userSnap.get('diamonds')) + diamonds,
          reason: 'daily_task',
          reasonLabel: label,
          context: 'reward',
          // Promotional, not purchased: never revenue, a liability until spent.
          funding: 'promotional',
          taskId,
          metric: task.metric,
          target: task.target,
          timestamp: now,
        })
      }
      if (beans > 0) {
        tx.set(userRef.collection('beanTransactions').doc(historyId), {
          type: 'credit',
          amount: beans,
          balanceAfter: num(userSnap.get('beans')) + beans,
          reason: 'daily_task',
          reasonLabel: label,
          context: 'reward',
          funding: 'promotional',
          taskId,
          metric: task.metric,
          target: task.target,
          timestamp: now,
        })
      }
      tx.set(promoRef, {
        kind: 'daily_task',
        uid,
        dateKey: today,
        taskId,
        title: task.title,
        metric: task.metric,
        target: task.target,
        progress: have,
        audience: task.audience,
        diamonds,
        beans,
        historyRow: diamondRow,
        beanHistoryRow: beanRow,
        source: 'claimDailyTask',
        createdAt: now,
      })
      tx.set(progressRef, {
        uid,
        dateKey: today,
        claimed: { ...claimed, [taskId]: { diamonds, beans, at: now } },
        updatedAt: now,
      }, { merge: true })

      return { taskId, diamonds, beans, dateKey: today }
    })
  })

/**
 * LEADERBOARDS AND REWARDS (B8, 3 Nov 2026) — Top 50 hosts, Top 50 supporters, Top lucky gifters; daily, weekly and
 * monthly, cut in IST; rewards the Owner sets in the CRM, paid once when a period closes.
 *
 * ── Scores: accrued where the money moves ─────────────────────────────────────
 *
 *   hosts       beans a host EARNED — gifts (settleGift) and calls (calls.ts settle) — same transaction as the credit
 *   supporters  diamonds a user SPENT on gifts (settleGift)
 *   lucky       diamonds spent on LUCKY gifts (settleGift; lucky gifts are off, so this board stays empty until the
 *               Owner switches them on)
 *
 * Every accrual is an increment on `leaderboards/{board}_{period}_{key}/entries/{uid}` written inside the
 * transaction that moved the money, so a score can never disagree with what was actually paid and a retried
 * transaction cannot count twice. No client writes a score (rules: read-only).
 *
 * ── Rewards: settled once per closed period ──────────────────────────────────
 *
 * `appConfig/leaderboards` (Owner-only) holds, per board and period, reward tiers — {from, to, amount} — and the
 * currency (diamonds, or beans for hosts). `settleLeaderboardsOnce` (scheduled 00:15 IST) settles every board whose
 * period has closed: one transaction per board writes `leaderboardSettlements/{boardDocId}` and each winner's credit
 * with deterministic ids, so a second run finds the settlement and pays nothing. Ties are broken by uid (stable,
 * stated). Restricted accounts (banned/suspended) and accounts marked `excludeFromLeaderboards` are skipped and
 * their rank is NOT given to the next person — the reward is simply not paid, and the settlement says why.
 * Every reward is also a `promoCredits` row (kind `leaderboard_reward`), so the CRM's promotions report counts it
 * as what it is: a cost Zipper chose to give away.
 */

import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { restrictionVerdict } from './mobileSession'
import { istDateKey, istWeekKey } from './time'

export type BoardId = 'hosts' | 'supporters' | 'lucky'
export type Period = 'daily' | 'weekly' | 'monthly'
export const BOARDS: readonly BoardId[] = ['hosts', 'supporters', 'lucky']
export const PERIODS: readonly Period[] = ['daily', 'weekly', 'monthly']
export const TOP = 50

const REGION = 'asia-south1'
const IST_MS = 330 * 60 * 1000
const inc = (n: number) => admin.firestore.FieldValue.increment(n)
const db = () => admin.firestore()

/** The IST period keys a moment falls in: `2026-11-03`, `2026-W45`, `2026-11`. */
export function periodKeys(at: Date = new Date()): Record<Period, string> {
  const ist = new Date(at.getTime() + IST_MS)
  return { daily: istDateKey(at), weekly: istWeekKey(at), monthly: ist.toISOString().slice(0, 7) }
}

export function boardDocId(board: BoardId, period: Period, key: string): string {
  return `${board}_${period}_${key}`
}

export interface Accrual { board: BoardId; uid: string; score: number; name?: string; photoUrl?: string }

/**
 * Add scores inside the caller's transaction (writes only — call it after every read). Zero and negative scores
 * are ignored.
 */
export function accrueBoards(tx: admin.firestore.Transaction, items: Accrual[], at: Date = new Date()): void {
  const keys = periodKeys(at)
  for (const a of items) {
    const score = Math.trunc(Number(a.score))
    if (!a.uid || !(score > 0)) continue
    for (const period of PERIODS) {
      const ref = db().collection('leaderboards').doc(boardDocId(a.board, period, keys[period])).collection('entries').doc(a.uid)
      tx.set(ref, {
        uid: a.uid,
        score: inc(score),
        name: String(a.name ?? '').slice(0, 60),
        photoUrl: String(a.photoUrl ?? ''),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true })
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  The Owner's reward tiers
// ══════════════════════════════════════════════════════════════════════════════

export interface Tier { from: number; to: number; amount: number }
export interface PeriodRewards { tiers: Tier[]; currency: 'diamonds' | 'beans' }
export interface BoardConfig { enabled: boolean; daily: PeriodRewards; weekly: PeriodRewards; monthly: PeriodRewards }
export interface LeaderboardsConfig { enabled: boolean; boards: Record<BoardId, BoardConfig> }

const emptyRewards = (currency: 'diamonds' | 'beans' = 'diamonds'): PeriodRewards => ({ tiers: [], currency })

/** Shown, not paying: every board visible except lucky; no reward until the Owner sets one. */
export function defaultLeaderboardsConfig(): LeaderboardsConfig {
  const board = (enabled: boolean): BoardConfig => ({ enabled, daily: emptyRewards(), weekly: emptyRewards(), monthly: emptyRewards() })
  return { enabled: true, boards: { hosts: board(true), supporters: board(true), lucky: board(false) } }
}

/** Clean tiers: whole ranks 1…50, from ≤ to, amounts 1…10 000 000, no overlaps (a later overlapping tier is dropped). */
export function cleanTiers(raw: unknown): Tier[] {
  if (!Array.isArray(raw)) return []
  const out: Tier[] = []
  for (const t of raw) {
    const r = (t ?? {}) as Record<string, unknown>
    const from = Math.trunc(Number(r.from))
    const to = Math.trunc(Number(r.to ?? r.from))
    const amount = Math.trunc(Number(r.amount))
    if (!(from >= 1 && to >= from && to <= TOP && amount >= 1 && amount <= 10_000_000)) continue
    if (out.some((o) => !(to < o.from || from > o.to))) continue
    out.push({ from, to, amount })
  }
  return out.sort((a, b) => a.from - b.from)
}

export function mergeLeaderboardsConfig(raw: Record<string, unknown> | undefined): LeaderboardsConfig {
  const d = defaultLeaderboardsConfig()
  if (!raw || typeof raw !== 'object') return d
  const boards = (raw.boards && typeof raw.boards === 'object' ? raw.boards : {}) as Record<string, Record<string, unknown>>
  const out: LeaderboardsConfig = { enabled: raw.enabled !== false, boards: { ...d.boards } }
  for (const b of BOARDS) {
    const g = boards[b] && typeof boards[b] === 'object' ? boards[b] : {}
    const per = (p: Period): PeriodRewards => {
      const r = (g[p] && typeof g[p] === 'object' ? g[p] : {}) as Record<string, unknown>
      // Beans are a host's currency; a supporter is always rewarded in diamonds.
      const currency = b === 'hosts' && r.currency === 'beans' ? 'beans' : 'diamonds'
      return { tiers: cleanTiers(r.tiers), currency }
    }
    // Lucky stays off unless switched on in so many words.
    const enabled = b === 'lucky' ? g.enabled === true : g.enabled !== false
    out.boards[b] = { enabled, daily: per('daily'), weekly: per('weekly'), monthly: per('monthly') }
  }
  return out
}

export function rewardFor(rank: number, tiers: Tier[]): number {
  return tiers.find((t) => rank >= t.from && rank <= t.to)?.amount ?? 0
}

// ══════════════════════════════════════════════════════════════════════════════
//  Settlement
// ══════════════════════════════════════════════════════════════════════════════

/** The keys of the periods that have CLOSED by `now`: yesterday; last week on Mondays; last month on the 1st. */
export function closedPeriods(now: Date): Array<{ period: Period; key: string }> {
  const ist = new Date(now.getTime() + IST_MS)
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  const out: Array<{ period: Period; key: string }> = [{ period: 'daily', key: periodKeys(yesterday).daily }]
  if (ist.getUTCDay() === 1) out.push({ period: 'weekly', key: periodKeys(yesterday).weekly })
  if (ist.getUTCDate() === 1) out.push({ period: 'monthly', key: periodKeys(yesterday).monthly })
  return out
}

export interface SettlementResult { boardDocId: string; status: 'settled' | 'already' | 'off' | 'empty'; paid: number; total: number }

/** Settle one board's closed period. Idempotent: the settlement document is the guard. */
export async function settleBoard(board: BoardId, period: Period, key: string, cfg: LeaderboardsConfig): Promise<SettlementResult> {
  const id = boardDocId(board, period, key)
  const bc = cfg.boards[board]
  const rewards = bc[period]
  if (!cfg.enabled || !bc.enabled || rewards.tiers.length === 0) return { boardDocId: id, status: 'off', paid: 0, total: 0 }
  const last = Math.max(...rewards.tiers.map((t) => t.to))
  return db().runTransaction(async (tx) => {
    const settleRef = db().collection('leaderboardSettlements').doc(id)
    const done = await tx.get(settleRef)
    if (done.exists) return { boardDocId: id, status: 'already' as const, paid: 0, total: 0 }
    const q = db().collection('leaderboards').doc(id).collection('entries').orderBy('score', 'desc').limit(last + 10)
    const snap = await tx.get(q)
    const ranked = snap.docs
      .map((d) => ({ uid: d.id, score: Number(d.get('score') ?? 0), name: String(d.get('name') ?? '') }))
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
      .slice(0, last)
    const users = new Map<string, admin.firestore.DocumentSnapshot>()
    for (const e of ranked) users.set(e.uid, await tx.get(db().collection('users').doc(e.uid)))
    // ── writes ──
    const winners: Array<Record<string, unknown>> = []
    let total = 0
    ranked.forEach((e, i) => {
      const rank = i + 1
      const amount = rewardFor(rank, rewards.tiers)
      if (amount <= 0) return
      const u = users.get(e.uid)
      const skipped = !u || !u.exists ? 'no_account'
        : u.get('excludeFromLeaderboards') === true ? 'excluded'
          : restrictionVerdict((f) => u.get(f)) ? 'restricted' : null
      if (skipped) { winners.push({ rank, uid: e.uid, score: e.score, amount: 0, skipped }); return }
      const userRef = db().collection('users').doc(e.uid)
      const field = rewards.currency === 'beans' ? 'beans' : 'diamonds'
      const before = Number(u!.get(field) ?? 0)
      tx.update(userRef, { [field]: inc(amount), leaderboardRewards: inc(amount) })
      if (field === 'diamonds') {
        tx.set(userRef.collection('diamondTransactions').doc(`lb_${id}`), {
          type: 'credit', amount, balanceAfter: before + amount, reason: 'leaderboard_reward',
          reasonLabel: `${labelOf(board)} — #${rank} ${period}`, context: 'leaderboard', board, period, periodKey: key, rank,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        })
      }
      tx.set(db().collection('promoCredits').doc(`lb_${id}_${rank}`), {
        kind: 'leaderboard_reward', uid: e.uid, board, period, periodKey: key, rank, score: e.score,
        ...(field === 'diamonds' ? { diamonds: amount } : { beans: amount }),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      })
      winners.push({ rank, uid: e.uid, name: e.name, score: e.score, amount, currency: field })
      total += amount
    })
    tx.set(settleRef, {
      board, period, periodKey: key, currency: rewards.currency, tiers: rewards.tiers, winners, total,
      settledAt: admin.firestore.FieldValue.serverTimestamp(),
    })
    return { boardDocId: id, status: ranked.length ? 'settled' as const : 'empty' as const, paid: winners.filter((w) => Number(w.amount) > 0).length, total }
  })
}

function labelOf(board: BoardId): string {
  return board === 'hosts' ? 'Top hosts' : board === 'supporters' ? 'Top supporters' : 'Lucky gifters'
}

export async function settleLeaderboardsOnce(now: Date = new Date()): Promise<SettlementResult[]> {
  const cfgSnap = await db().collection('appConfig').doc('leaderboards').get()
  const cfg = mergeLeaderboardsConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
  const out: SettlementResult[] = []
  for (const { period, key } of closedPeriods(now)) {
    for (const board of BOARDS) out.push(await settleBoard(board, period, key, cfg))
  }
  return out
}

/** 00:15 IST: the day (and on Mondays the week, on the 1st the month) that just closed. */
export const settleLeaderboards = functions.region(REGION).pubsub.schedule('15 0 * * *').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const r = await settleLeaderboardsOnce(new Date())
    const paid = r.filter((x) => x.status === 'settled')
    if (paid.length) functions.logger.info(`settleLeaderboards: ${paid.map((p) => `${p.boardDocId} ${p.paid} paid ${p.total}`).join('; ')}`)
    return null
  })

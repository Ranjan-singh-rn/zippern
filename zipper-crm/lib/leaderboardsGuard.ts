/**
 * Leaderboard rewards (B8, 3 Nov 2026) — pure, so it is tested without Firestore (`leaderboardsGuard.spec.ts`).
 *
 * The shape of `appConfig/leaderboards`, read by the settlement job (functions/src/leaderboards.ts —
 * `mergeLeaderboardsConfig` / `cleanTiers` clean it the same way, so a bad save here can never pay a rank twice or
 * pay rank 51). Rankings are shown by default; NOTHING is paid until the Owner sets a tier. Lucky gifters stays off
 * unless switched on. Writing the document is the Owner's alone (firestore.rules E6).
 */

export const BOARD_IDS = ['hosts', 'supporters', 'lucky'] as const
export type BoardId = (typeof BOARD_IDS)[number]
export const PERIODS = ['daily', 'weekly', 'monthly'] as const
export type Period = (typeof PERIODS)[number]
export const TOP = 50

export const BOARD_LABELS: Record<BoardId, string> = {
  hosts: 'Top hosts (beans earned)',
  supporters: 'Top supporters (diamonds spent on gifts)',
  lucky: 'Lucky gifters (diamonds spent on lucky gifts)',
}

export interface Tier { from: number; to: number; amount: number }
export interface PeriodRewards { tiers: Tier[]; currency: 'diamonds' | 'beans' }
export interface BoardConfig { enabled: boolean; daily: PeriodRewards; weekly: PeriodRewards; monthly: PeriodRewards }
export interface LeaderboardsConfig { enabled: boolean; boards: Record<BoardId, BoardConfig> }

const empty = (): PeriodRewards => ({ tiers: [], currency: 'diamonds' })

export function defaultLeaderboardsConfig(): LeaderboardsConfig {
  const board = (enabled: boolean): BoardConfig => ({ enabled, daily: empty(), weekly: empty(), monthly: empty() })
  return { enabled: true, boards: { hosts: board(true), supporters: board(true), lucky: board(false) } }
}

/** Whole ranks 1…50, from ≤ to, amounts 1…10 000 000; a tier overlapping an earlier one is dropped. */
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

export function mergeLeaderboardsConfig(raw: unknown): LeaderboardsConfig {
  const d = defaultLeaderboardsConfig()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const boards = (r.boards && typeof r.boards === 'object' ? r.boards : {}) as Record<string, Record<string, unknown>>
  const out: LeaderboardsConfig = { enabled: r.enabled !== false, boards: { ...d.boards } }
  for (const b of BOARD_IDS) {
    const g = boards[b] && typeof boards[b] === 'object' ? boards[b] : {}
    const per = (p: Period): PeriodRewards => {
      const x = (g[p] && typeof g[p] === 'object' ? g[p] : {}) as Record<string, unknown>
      return { tiers: cleanTiers(x.tiers), currency: b === 'hosts' && x.currency === 'beans' ? 'beans' : 'diamonds' }
    }
    out.boards[b] = { enabled: b === 'lucky' ? g.enabled === true : g.enabled !== false, daily: per('daily'), weekly: per('weekly'), monthly: per('monthly') }
  }
  return out
}

/** What one closed period pays in total if every rewarded rank is filled. */
export function periodCost(tiers: Tier[]): number {
  return tiers.reduce((a, t) => a + (t.to - t.from + 1) * t.amount, 0)
}

/** Problems that block a save, in words. Overlaps and out-of-range ranks are reported rather than silently dropped. */
export function leaderboardsProblems(draft: Record<BoardId, Record<Period, Tier[]>>): string[] {
  const out: string[] = []
  for (const b of BOARD_IDS) {
    for (const p of PERIODS) {
      const raw = draft[b]?.[p] ?? []
      const clean = cleanTiers(raw)
      if (clean.length !== raw.length) out.push(`${BOARD_LABELS[b]} — ${p}: every tier needs ranks 1–${TOP} (from ≤ to), a positive amount, and no overlap.`)
    }
  }
  return out
}

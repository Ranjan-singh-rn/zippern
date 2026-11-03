/**
 * INSTANT GAMES — the maths, pure (B5, 3 Nov 2026).
 *
 * Every outcome is a function of a server draw (`rng.ts`) and the published tables below — nothing else. The
 * tables are built so the RETURN TO PLAYER is at most the configured target (1 − house edge): the tests compute
 * each game's exact (or simulated) RTP and fail if any exceeds it. The animation on the phone only shows the result.
 *
 *   Zip Flight (crash)   crash point c = max(1, ⌊(1 − edge) / (1 − r) × 100⌋ / 100), capped. P(c ≥ x) = (1 − edge)/x,
 *                        so cashing out at any x returns (1 − edge). The multiplier grows as e^(K·t).
 *   Lane Hopper          each lane is lost with probability p (per difficulty); after k safe lanes the multiplier is
 *   (chicken road)       (1 − edge) / (1 − p)^k, so collecting after any k returns (1 − edge).
 *   Peg Drop (plinko)    `rows` left/right bounces; bin = number of rights; a binomial table per (rows, risk),
 *                        scaled to the RTP and floored to 2 decimals.
 *   Mela Reels (slots)   5×3, 10 lines, 6 symbols drawn per cell by weight; 3/4/5-of-a-kind from the left.
 *   Lucky Catch          one cast, one catch from a weighted table.
 */

import { drawFloat, drawInt, drawWeighted } from './rng'

const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100

// ── Zip Flight (crash) ─────────────────────────────────────────────────────────

/** Growth rate: the multiplier doubles every 10 seconds (e^(0.0693·10) ≈ 2). */
export const CRASH_K = Math.log(2) / 10

export function crashPoint(seed: string, label: string, edgePct: number, maxMultiplier: number): number {
  const r = drawFloat(seed, label)
  const raw = (1 - edgePct / 100) / (1 - r)
  return Math.min(Math.max(1, floor2(raw)), maxMultiplier)
}

/** The multiplier `ms` milliseconds into the flight, floored to 2 decimals. */
export function crashMultiplierAt(ms: number): number {
  return floor2(Math.exp(CRASH_K * Math.max(0, ms) / 1000))
}

/** How long the flight lasts before crashing at `c` (ms). */
export function crashFlightMs(c: number): number {
  return Math.ceil((Math.log(Math.max(1, c)) / CRASH_K) * 1000)
}

// ── Lane Hopper (chicken road) ─────────────────────────────────────────────────

export const CHICKEN_DIFFICULTY: Record<string, number> = {
  easy: 1 / 25,
  medium: 3 / 25,
  hard: 5 / 25,
  daredevil: 10 / 25,
}

/** The first lane (1-based) that is lost, or lanes + 1 if every lane is safe. */
export function chickenDeathLane(seed: string, label: string, p: number, lanes: number): number {
  for (let lane = 1; lane <= lanes; lane++) {
    if (drawFloat(seed, `${label}:lane:${lane}`) < p) return lane
  }
  return lanes + 1
}

export function chickenMultiplier(k: number, p: number, edgePct: number): number {
  if (k <= 0) return 1
  return floor2((1 - edgePct / 100) / Math.pow(1 - p, k))
}

// ── Peg Drop (plinko) ──────────────────────────────────────────────────────────

const PLINKO_SHAPE: Record<string, number> = { low: 1.18, medium: 1.5, high: 2.05 }

function binom(n: number, k: number): number {
  let c = 1
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i
  return c
}

/** The multiplier of every bin for (rows, risk), scaled to `rtp` and floored to 2 decimals, capped at `max`. */
export function plinkoTable(rows: number, risk: string, rtp: number, max = 1000): number[] {
  const c = PLINKO_SHAPE[risk] ?? PLINKO_SHAPE.medium
  const shape = Array.from({ length: rows + 1 }, (_, k) => Math.pow(c, Math.abs(k - rows / 2)))
  const total = Math.pow(2, rows)
  const ev = shape.reduce((a, s, k) => a + (binom(rows, k) / total) * s, 0)
  const scale = rtp / ev
  return shape.map((s) => Math.min(max, floor2(s * scale)))
}

export function plinkoRtp(rows: number, table: number[]): number {
  const total = Math.pow(2, rows)
  return table.reduce((a, m, k) => a + (binom(rows, k) / total) * m, 0)
}

/** The bounces (0 = left, 1 = right) and the bin they land in. */
export function plinkoDrop(seed: string, label: string, rows: number): { path: number[]; bin: number } {
  const path = Array.from({ length: rows }, (_, i) => drawInt(seed, `${label}:peg:${i}`, 2))
  return { path, bin: path.reduce((a, b) => a + b, 0) }
}

// ── Mela Reels (slots) ─────────────────────────────────────────────────────────

/** Six original symbols, lowest to highest, and their per-cell weights. */
export const SLOT_SYMBOLS = ['marigold', 'kite', 'drum', 'lantern', 'peacock', 'elephant'] as const
export const SLOT_WEIGHTS = [30, 25, 18, 13, 9, 5]
/** Line pays for 3 / 4 / 5 of a kind, as multiples of the LINE bet, before RTP scaling. */
const SLOT_BASE_PAYS: number[][] = [
  [4, 10, 25], [5, 14, 40], [8, 22, 70], [12, 35, 120], [20, 60, 250], [40, 150, 800],
]
/** Ten lines across a 5×3 window: the row (0 top … 2 bottom) taken on each of the 5 reels. */
export const SLOT_LINES: number[][] = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0],
]

function slotLineEv(pays: number[][]): number {
  const total = SLOT_WEIGHTS.reduce((a, b) => a + b, 0)
  let ev = 0
  SLOT_WEIGHTS.forEach((w, s) => {
    const p = w / total
    ev += Math.pow(p, 3) * (1 - p) * pays[s][0] + Math.pow(p, 4) * (1 - p) * pays[s][1] + Math.pow(p, 5) * pays[s][2]
  })
  return ev
}

/** The paytable scaled so one line's expected return is `rtp` × the line bet (floored to 2 decimals). */
export function slotPaytable(rtp: number): number[][] {
  const scale = rtp / slotLineEv(SLOT_BASE_PAYS)
  return SLOT_BASE_PAYS.map((row) => row.map((m) => floor2(m * scale)))
}

/** Exact expected return of a spin (all 10 lines), as a fraction of the total bet. */
export function slotRtp(pays: number[][]): number {
  return slotLineEv(pays)
}

export interface SlotSpin { grid: number[][]; wins: Array<{ line: number; symbol: number; count: number; multiplier: number }>; multiplier: number }

/** A spin: the 5×3 grid (grid[reel][row]) and every winning line. `multiplier` is the total, of the TOTAL bet. */
export function slotSpin(seed: string, label: string, pays: number[][]): SlotSpin {
  const grid = Array.from({ length: 5 }, (_, reel) =>
    Array.from({ length: 3 }, (_, row) => drawWeighted(seed, `${label}:cell:${reel}:${row}`, SLOT_WEIGHTS)))
  const wins: SlotSpin['wins'] = []
  SLOT_LINES.forEach((line, li) => {
    const first = grid[0][line[0]]
    let count = 1
    while (count < 5 && grid[count][line[count]] === first) count++
    if (count >= 3) {
      const m = pays[first][count - 3]
      wins.push({ line: li, symbol: first, count, multiplier: floor2(m / SLOT_LINES.length) })
    }
  })
  const multiplier = floor2(wins.reduce((a, w) => a + w.multiplier, 0))
  return { grid, wins, multiplier }
}

// ── Lucky Catch (fishing) ──────────────────────────────────────────────────────

export const CATCHES = [
  { id: 'boot', name: 'Old boot', base: 0, weight: 3200 },
  { id: 'minnow', name: 'Minnow', base: 0.5, weight: 2800 },
  { id: 'rohu', name: 'Rohu', base: 1.2, weight: 2100 },
  { id: 'catla', name: 'Catla', base: 2, weight: 1100 },
  { id: 'puffer', name: 'Pufferfish', base: 5, weight: 500 },
  { id: 'octopus', name: 'Octopus', base: 10, weight: 220 },
  { id: 'turtle', name: 'Sea turtle', base: 25, weight: 60 },
  { id: 'golden', name: 'Golden fish', base: 100, weight: 20 },
] as const

/** The catch table scaled to `rtp` (floored to 2 decimals). */
export function catchTable(rtp: number): Array<{ id: string; name: string; multiplier: number; weight: number }> {
  const total = CATCHES.reduce((a, c) => a + c.weight, 0)
  const ev = CATCHES.reduce((a, c) => a + (c.weight / total) * c.base, 0)
  const scale = rtp / ev
  return CATCHES.map((c) => ({ id: c.id, name: c.name, multiplier: floor2(c.base * scale), weight: c.weight }))
}

export function catchRtp(table: Array<{ multiplier: number; weight: number }>): number {
  const total = table.reduce((a, c) => a + c.weight, 0)
  return table.reduce((a, c) => a + (c.weight / total) * c.multiplier, 0)
}

export function castLine(seed: string, label: string, table: Array<{ id: string; name: string; multiplier: number; weight: number }>) {
  return table[drawWeighted(seed, label, table.map((c) => c.weight))]
}

/** What a stake wins at a multiplier: floored, so the server never pays a fraction of a diamond it did not owe. */
export function payoutFor(stake: number, multiplier: number): number {
  return Math.floor(Math.trunc(stake) * multiplier + 1e-9)
}

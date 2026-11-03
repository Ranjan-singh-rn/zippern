/**
 * The odds and payouts of the second set of quick games (B5, 3 Nov 2026) — pure, so every RTP is checked by a test
 * (test/moreGames.test.js). Every table is built from the house edge the Owner sets in the CRM: the return to
 * player is (1 − edge), and every multiplier is rounded DOWN to the cent, so rounding never favours the house's
 * opponent by accident and never pays more than the stated return.
 *
 *   dice          Lucky Dice        roll 0.00–99.99, win chance 2–95 %, under or over
 *   coin_toss     Toss Up           heads or tails
 *   wheel         Fortune Wheel     20 segments, low / medium / high risk
 *   keno          Number Draw       pick 1–10 of 40, ten are drawn
 *   limbo         Sky High          pick a target; the result must reach it
 *   roulette      Roulette          one zero, 37 pockets; straight, colours, odd/even, halves, dozens, columns
 *   dragon_tiger  Dragon Tiger      one card each side, higher wins; a tie returns half
 *   andar_bahar   Andar Bahar       a joker, then cards to each side until one matches it
 *   hilo          Higher or Lower   guess the next card, cash out when you like
 *   mines         Gem Field         25 tiles, 1–24 mines, cash out when you like
 */

import { drawFloat, drawInt, shuffle } from './rng'

export const floor2 = (x: number): number => Math.floor(x * 100 + 1e-9) / 100

// ── Lucky Dice ────────────────────────────────────────────────────────────────

export function diceMultiplier(chancePct: number, edgePct: number): number {
  return floor2(((100 - edgePct) / chancePct))
}

/** A roll of 0…9999 (shown as 0.00–99.99): under wins below chance × 100; over wins from 10000 − chance × 100. */
export function diceRoll(seed: string, label: string): number {
  return drawInt(seed, label, 10_000)
}

export function diceWins(roll: number, chancePct: number, direction: 'under' | 'over'): boolean {
  const cut = Math.round(chancePct * 100)
  return direction === 'under' ? roll < cut : roll >= 10_000 - cut
}

// ── Toss Up ───────────────────────────────────────────────────────────────────

export function coinMultiplier(edgePct: number): number {
  return floor2(2 * (1 - edgePct / 100))
}

export function coinFlip(seed: string, label: string): 'heads' | 'tails' {
  return drawInt(seed, label, 2) === 0 ? 'heads' : 'tails'
}

// ── Fortune Wheel ─────────────────────────────────────────────────────────────

const WHEEL_BASE: Record<string, number[]> = {
  low: [1.5, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0, 1.5, 1.2, 1.2, 1.2, 0, 1.2, 1.2, 1.2, 1.2, 0],
  medium: [0, 1.5, 0, 2, 0, 1.5, 0, 3, 0, 1.5, 0, 2, 0, 1.5, 0, 4, 0, 1.5, 0, 1.7],
  high: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 19.8],
}
export const WHEEL_RISKS = Object.keys(WHEEL_BASE)

/** The 20 segments for a risk, scaled so the wheel returns (1 − edge). */
export function wheelTable(risk: string, edgePct: number): number[] {
  const base = WHEEL_BASE[risk] ?? WHEEL_BASE.medium
  const ev = base.reduce((a, b) => a + b, 0) / base.length
  const k = (1 - edgePct / 100) / ev
  return base.map((m) => (m > 0 ? floor2(m * k) : 0))
}

export function wheelSpin(seed: string, label: string, segments: number): number {
  return drawInt(seed, label, segments)
}

// ── Number Draw (keno) ────────────────────────────────────────────────────────

export const KENO_NUMBERS = 40
export const KENO_DRAWN = 10

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}

/** P(h hits) when n numbers are picked and ten of forty are drawn. */
export function kenoHitChance(picks: number, hits: number): number {
  return (choose(picks, hits) * choose(KENO_NUMBERS - picks, KENO_DRAWN - hits)) / choose(KENO_NUMBERS, KENO_DRAWN)
}

/**
 * The paytable for `picks` numbers, index = hits: nothing below half the picks (one for one or two picks), then
 * doubling with every hit, all of them treble — scaled to (1 − edge).
 */
export function kenoTable(picks: number, edgePct: number): number[] {
  const k0 = picks <= 2 ? 1 : Math.ceil(picks / 2)
  const base = Array.from({ length: picks + 1 }, (_, h) => (h < k0 ? 0 : 2 ** (h - k0) * (h === picks ? 3 : 1)))
  const ev = base.reduce((a, m, h) => a + m * kenoHitChance(picks, h), 0)
  const k = (1 - edgePct / 100) / ev
  return base.map((m) => (m > 0 ? floor2(m * k) : 0))
}

/** Ten different numbers 1…40. */
export function kenoDraw(seed: string, label: string): number[] {
  return shuffle(seed, `${label}:keno`, KENO_NUMBERS).slice(0, KENO_DRAWN).map((i) => i + 1)
}

// ── Sky High (limbo) ──────────────────────────────────────────────────────────

export const LIMBO_MAX = 1000

/** The result: (1 − edge) / U, at least 1.00, at most LIMBO_MAX; reaching the target t has chance (1 − edge) / t. */
export function limboResult(seed: string, label: string, edgePct: number): number {
  const u = 1 - drawFloat(seed, label) // (0, 1]
  return Math.min(LIMBO_MAX, Math.max(1, floor2((1 - edgePct / 100) / u)))
}

// ── Roulette ──────────────────────────────────────────────────────────────────

export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36])
export type RouletteBet = 'straight' | 'red' | 'black' | 'odd' | 'even' | 'low' | 'high' | 'dozen' | 'column'
export const ROULETTE_BETS: RouletteBet[] = ['straight', 'red', 'black', 'odd', 'even', 'low', 'high', 'dozen', 'column']

/** How many of the 37 pockets a bet covers. */
export function rouletteCovers(bet: RouletteBet): number {
  return bet === 'straight' ? 1 : bet === 'dozen' || bet === 'column' ? 12 : 18
}

/** Scaled to (1 − edge); at the zero's own edge (2.70 %) these are the familiar 36×, 3× and 2×. */
export function rouletteMultiplier(bet: RouletteBet, edgePct: number): number {
  return floor2((37 / rouletteCovers(bet)) * (1 - edgePct / 100) + 1e-6)
}

/** The pocket the ball lands in: 0…36, each 1 in 37. */
export function roulettePocket(seed: string, label: string): number {
  return drawInt(seed, `${label}:roulette`, 37)
}

export function rouletteWins(pocket: number, bet: RouletteBet, pick: number): boolean {
  if (pocket === 0) return bet === 'straight' && pick === 0
  switch (bet) {
    case 'straight': return pocket === pick
    case 'red': return RED.has(pocket)
    case 'black': return !RED.has(pocket)
    case 'odd': return pocket % 2 === 1
    case 'even': return pocket % 2 === 0
    case 'low': return pocket <= 18
    case 'high': return pocket >= 19
    case 'dozen': return Math.ceil(pocket / 12) === pick
    case 'column': return ((pocket - 1) % 3) + 1 === pick
  }
}

// ── Dragon Tiger ──────────────────────────────────────────────────────────────

/** Ace low, king high: value 0 (A) … 12 (K). Cards are 0…51 with rank = card % 13 (0 = 2 … 12 = A). */
export const dtValue = (card: number): number => ((card % 13) + 1) % 13

export function dragonTigerDeal(seed: string, label: string): { dragon: number; tiger: number } {
  const deck = shuffle(seed, `${label}:dt`, 52)
  return { dragon: deck[0], tiger: deck[1] }
}

const DT_TIE = 3 / 51
const DT_SIDE = 24 / 51

/** A side bet pays this on a win and returns half on a tie; a tie bet pays its own multiplier. */
export function dragonTigerMultipliers(edgePct: number): { side: number; tie: number; tieRefund: number } {
  const rtp = 1 - edgePct / 100
  return { side: floor2((rtp - 0.5 * DT_TIE) / DT_SIDE), tie: floor2(rtp / DT_TIE), tieRefund: 0.5 }
}

// ── Andar Bahar ───────────────────────────────────────────────────────────────

/** P(the first card matching the joker falls on Andar), Andar dealt first: positions 1, 3, 5 … of the 51 left. */
export const ANDAR_CHANCE = (() => {
  let odd = 0
  for (let k = 1; k <= 49; k += 2) odd += choose(51 - k, 2)
  return odd / choose(51, 3)
})()

export function andarBaharMultipliers(edgePct: number): { andar: number; bahar: number } {
  const rtp = 1 - edgePct / 100
  return { andar: floor2(rtp / ANDAR_CHANCE), bahar: floor2(rtp / (1 - ANDAR_CHANCE)) }
}

export function andarBaharDeal(seed: string, label: string): { joker: number; dealt: number[]; winner: 'andar' | 'bahar' } {
  const deck = shuffle(seed, `${label}:ab`, 52)
  const joker = deck[0]
  const dealt: number[] = []
  for (let i = 1; i < deck.length; i++) {
    dealt.push(deck[i])
    if (deck[i] % 13 === joker % 13) break
  }
  return { joker, dealt, winner: dealt.length % 2 === 1 ? 'andar' : 'bahar' }
}

// ── Higher or Lower ───────────────────────────────────────────────────────────

/** Rank 0 (2) … 12 (A). "Higher" means higher or the same; "lower", lower or the same. */
export function hiloChance(card: number, guess: 'higher' | 'lower'): number {
  const r = card % 13
  return guess === 'higher' ? (13 - r) / 13 : (r + 1) / 13
}

/** What a correct guess multiplies the round by. */
export function hiloFactor(card: number, guess: 'higher' | 'lower', edgePct: number): number {
  return (1 - edgePct / 100) / hiloChance(card, guess)
}

export function hiloCorrect(card: number, next: number, guess: 'higher' | 'lower'): boolean {
  return guess === 'higher' ? next % 13 >= card % 13 : next % 13 <= card % 13
}

export const HILO_DECK = 60

/** The round's cards, fixed when it starts (drawn with replacement, as from an endless shoe). */
export function hiloCards(seed: string, label: string): number[] {
  return Array.from({ length: HILO_DECK }, (_, i) => drawInt(seed, `${label}:hilo:${i}`, 52))
}

// ── Gem Field (mines) ─────────────────────────────────────────────────────────

export const MINES_TILES = 25

/** After `safe` gems with `mines` mines: (1 − edge) × C(25, safe) / C(25 − mines, safe). */
export function minesMultiplier(mines: number, safe: number, edgePct: number): number {
  if (safe <= 0) return 1
  let m = 1
  for (let i = 0; i < safe; i++) m *= (MINES_TILES - i) / (MINES_TILES - mines - i)
  return floor2(m * (1 - edgePct / 100))
}

export function minesLayout(seed: string, label: string, mines: number): number[] {
  return shuffle(seed, `${label}:mines`, MINES_TILES).slice(0, mines).sort((a, b) => a - b)
}

/**
 * TEEN PATTI — the rules, pure (B4, 3 Nov 2026). Written down before it was built: Zipper's table variant.
 *
 *   * 2–6 players, one 52-card deck, three cards each, dealt by the server from the match seed.
 *   * Everyone pays the BOOT (the table's entry) into the pot when they sit; the match starts when the table is full.
 *   * Everyone starts BLIND. The current stake starts at the boot. On your turn you may first SEE your cards, then:
 *       chaal   — stay in: a blind player pays the stake, a seen player twice the stake;
 *       raise   — double the stake, then pay as chaal at the new stake;
 *       pack    — fold; what you paid stays in the pot;
 *       show    — only when two players are left: pay as chaal, both hands are compared, the better takes the pot.
 *   * The pot limit (potLimitX × boot): once the pot reaches it, every player still in shows, the best hand wins.
 *   * A turn not taken in time is a PACK (the cards are not played for the absent player).
 *   * The last player not packed wins without a show.
 *   * Hands, best first: Trail (three of a kind) · Pure sequence (straight flush) · Sequence · Colour (flush) ·
 *     Pair · High card. In sequences A-K-Q is the highest, A-2-3 the second, then K-Q-J down to 4-3-2.
 *     Equal hands split the pot (any indivisible diamond goes to the platform, see ledger.splitPool).
 *   * Not in this version: side-show, the blind limit.
 *
 * Cards are 0…51: rank = card % 13 (0 = 2 … 12 = A), suit = ⌊card / 13⌋.
 */

import { shuffle } from './rng'

export const RANKS = '23456789TJQKA'
export const SUITS = '♠♥♦♣'

export enum HandClass { HighCard = 0, Pair = 1, Colour = 2, Sequence = 3, PureSequence = 4, Trail = 5 }

export interface HandValue { cls: HandClass; tiebreak: number[]; name: string }

export function cardName(c: number): string {
  return RANKS[c % 13] + SUITS[Math.floor(c / 13)]
}

/** Sequence strength: A-K-Q = 13 (highest), A-2-3 = 12, K-Q-J = 10 … 4-3-2 = 1; null when not a sequence. */
function sequenceStrength(ranks: number[]): number | null {
  const r = [...ranks].sort((a, b) => b - a)
  if (r[0] === 12 && r[1] === 11 && r[2] === 10) return 13          // A K Q
  if (r[0] === 12 && r[1] === 1 && r[2] === 0) return 12            // A 3 2
  if (r[0] - r[1] === 1 && r[1] - r[2] === 1) return r[0] - 1       // K Q J = 11 … 4 3 2 = 1
  return null
}

export function evaluate(cards: number[]): HandValue {
  if (cards.length !== 3) throw new Error('teen patti: a hand is three cards')
  const ranks = cards.map((c) => c % 13)
  const suits = cards.map((c) => Math.floor(c / 13))
  const sorted = [...ranks].sort((a, b) => b - a)
  const flush = suits[0] === suits[1] && suits[1] === suits[2]
  const seq = sequenceStrength(ranks)
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) return { cls: HandClass.Trail, tiebreak: [sorted[0]], name: 'Trail' }
  if (flush && seq !== null) return { cls: HandClass.PureSequence, tiebreak: [seq], name: 'Pure sequence' }
  if (seq !== null) return { cls: HandClass.Sequence, tiebreak: [seq], name: 'Sequence' }
  if (flush) return { cls: HandClass.Colour, tiebreak: sorted, name: 'Colour' }
  if (sorted[0] === sorted[1] || sorted[1] === sorted[2]) {
    const pair = sorted[1]
    const kicker = sorted[0] === sorted[1] ? sorted[2] : sorted[0]
    return { cls: HandClass.Pair, tiebreak: [pair, kicker], name: 'Pair' }
  }
  return { cls: HandClass.HighCard, tiebreak: sorted, name: 'High card' }
}

/** > 0 when a beats b, < 0 when b beats a, 0 for equal hands. */
export function compareHands(a: number[], b: number[]): number {
  const va = evaluate(a)
  const vb = evaluate(b)
  if (va.cls !== vb.cls) return va.cls - vb.cls
  for (let i = 0; i < Math.max(va.tiebreak.length, vb.tiebreak.length); i++) {
    const d = (va.tiebreak[i] ?? -1) - (vb.tiebreak[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** Deal three cards to each of `players` from a shuffled deck. */
export function deal(seed: string, label: string, players: number): number[][] {
  const deck = shuffle(seed, `${label}:deck`, 52)
  return Array.from({ length: players }, (_, p) => [deck[p * 3], deck[p * 3 + 1], deck[p * 3 + 2]])
}

export interface TeenPattiState {
  players: number
  boot: number
  stake: number
  pot: number
  potLimit: number
  /** What each player has put into the pot (boot included). */
  paid: number[]
  seen: boolean[]
  packed: boolean[]
  turn: number
  step: number
  turnNumber: number
  /** Winner(s) by player index once the game is over. */
  winners: number[] | null
  /** How it ended: 'packed' (last one standing), 'show', 'pot_limit'. */
  endedBy: string | null
}

export function newTeenPatti(players: number, boot: number, potLimitX: number, firstPlayer = 0): TeenPattiState {
  if (players < 2 || players > 6) throw new Error('teen patti: 2 to 6 players')
  return {
    players, boot, stake: boot, pot: boot * players, potLimit: boot * Math.max(2, potLimitX),
    paid: Array.from({ length: players }, () => boot),
    seen: Array.from({ length: players }, () => false),
    packed: Array.from({ length: players }, () => false),
    turn: firstPlayer % players, step: 0, turnNumber: 1, winners: null, endedBy: null,
  }
}

function clone(s: TeenPattiState): TeenPattiState {
  return { ...s, paid: [...s.paid], seen: [...s.seen], packed: [...s.packed], winners: s.winners ? [...s.winners] : null }
}

function stillIn(s: TeenPattiState): number[] {
  return s.packed.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0)
}

function nextTurn(s: TeenPattiState): void {
  for (let k = 1; k <= s.players; k++) {
    const cand = (s.turn + k) % s.players
    if (!s.packed[cand]) { s.turn = cand; break }
  }
  s.turnNumber += 1
}

/** What a chaal costs this player now (raise: at the doubled stake). */
export function chaalCost(s: TeenPattiState, player: number, raise: boolean): number {
  const stake = raise ? s.stake * 2 : s.stake
  return s.seen[player] ? stake * 2 : stake
}

/** Best hand(s) among `players` — more than one on an exact tie. */
export function bestOf(hands: number[][], players: number[]): number[] {
  let best: number[] = []
  for (const p of players) {
    if (best.length === 0) { best = [p]; continue }
    const c = compareHands(hands[p], hands[best[0]])
    if (c > 0) best = [p]
    else if (c === 0) best.push(p)
  }
  return best
}

export interface TPResult { state: TeenPattiState; cost: number; event: Record<string, unknown> }

function finish(s: TeenPattiState, winners: number[], endedBy: string): void {
  s.winners = winners
  s.endedBy = endedBy
}

/**
 * A player looks at their cards (their turn or not — seeing is never an obstacle to anybody else). It does not
 * advance `step`: `step` counts turn actions, and another player's pending tap must not go stale because somebody
 * else looked at their cards (what a chaal costs depends only on the bettor's own seen flag).
 */
export function see(state: TeenPattiState, player: number): TeenPattiState {
  if (state.winners) throw new Error('teen patti: the game is over')
  if (state.packed[player]) throw new Error('teen patti: you have packed')
  if (state.seen[player]) return state
  const s = clone(state)
  s.seen[player] = true
  return s
}

/** The current player acts. `hands` are needed for a show and for the pot limit. */
export function act(state: TeenPattiState, player: number, action: 'chaal' | 'raise' | 'pack' | 'show', hands: number[][]): TPResult {
  if (state.winners) throw new Error('teen patti: the game is over')
  if (state.turn !== player) throw new Error('teen patti: it is not your turn')
  const s = clone(state)
  s.step += 1
  if (action === 'pack') {
    s.packed[player] = true
    const left = stillIn(s)
    if (left.length === 1) { finish(s, left, 'packed'); return { state: s, cost: 0, event: { action, player } } }
    nextTurn(s)
    return { state: s, cost: 0, event: { action, player } }
  }
  if (action === 'show' && stillIn(s).length !== 2) throw new Error('teen patti: a show needs exactly two players left')
  const raise = action === 'raise'
  const cost = chaalCost(s, player, raise)
  if (raise) s.stake *= 2
  s.paid[player] += cost
  s.pot += cost
  if (action === 'show') {
    finish(s, bestOf(hands, stillIn(s)), 'show')
    return { state: s, cost, event: { action, player, cost } }
  }
  if (s.pot >= s.potLimit) {
    finish(s, bestOf(hands, stillIn(s)), 'pot_limit')
    return { state: s, cost, event: { action, player, cost, potLimit: true } }
  }
  nextTurn(s)
  return { state: s, cost, event: { action, player, cost } }
}

/** A player who leaves, or whose turn ran out, packs. */
export function forfeit(state: TeenPattiState, player: number): TeenPattiState {
  if (state.winners || state.packed[player]) return state
  const s = clone(state)
  s.step += 1
  s.packed[player] = true
  const left = stillIn(s)
  if (left.length === 1) finish(s, left, 'packed')
  else if (s.turn === player) nextTurn(s)
  return s
}

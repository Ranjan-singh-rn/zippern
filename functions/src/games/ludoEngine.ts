/**
 * LUDO — the rules, pure (B4, 3 Nov 2026). No Firestore, no clock, no randomness: the die value comes in from the
 * server's RNG (`rng.ts`) and everything else is a function of the state. Tested move by move.
 *
 * ── The board ────────────────────────────────────────────────────────────────
 *
 * `arms` coloured arms around a centre: 4 for 2- and 4-player games (the classic cross), 6 for 6-player games
 * (a hexagonal board). Each arm contributes 13 squares to the shared main track, so the track has `arms × 13`
 * squares. A player sits on one arm; their start square is that arm's first square.
 *
 * A token's position is RELATIVE to its owner's start:
 *
 *   -1                yard (not yet out)
 *   0 … TRACK-1       on the main track (TRACK = arms × 13 − 1: one lap less the square before the start)
 *   TRACK … HOME-1    the owner's home column (5 squares)
 *   HOME              home (finished)            HOME = TRACK + 5
 *
 * For 4 arms that is the classic 0…50 track, 51…55 home column, 56 home.
 *
 * ── The rules (Zipper's variant, written down before it was built) ──────────
 *
 *   * A 6 brings a token out of the yard onto its start square.
 *   * A token moves exactly the die value; it must land on HOME exactly — a roll that would overshoot is not a move.
 *   * Landing on an opponent on the main track sends every opponent token on that square back to its yard
 *     (a capture) — except on a SAFE square: every arm's start square and its star square (start + 8).
 *   * Extra turn for a 6, for a capture, and for bringing a token home. Three 6s in a row forfeit the turn
 *     (the third 6 is not moved).
 *   * No legal move: the turn passes. Exactly one legal move: it is made for the player (no tap needed).
 *   * A player wins when `tokensToWin` of their tokens are home (4 is the classic game; fewer makes it quicker).
 *     The game ends at the first winner. A player who leaves or misses three turns in a row forfeits; the last
 *     player standing wins.
 */

export const SEGMENT = 13
export const HOME_COLUMN = 5
export const TOKENS = 4
export const MAX_MISSED_TURNS = 3

export interface LudoState {
  arms: 4 | 6
  /** The arm each player sits on, by player index. */
  armOf: number[]
  /** Per player, per token: the relative position (see the header). */
  tokens: number[][]
  /** The player whose turn it is. */
  turn: number
  /** The die value rolled this turn and not yet moved; null = the player must roll. */
  roll: number | null
  /** Consecutive 6s rolled by the current player this turn. */
  sixes: number
  /** Increments on every state change, so a client's action names the state it was looking at. */
  step: number
  /** Turn counter (increments when the turn passes to another player or the same player gets an extra turn). */
  turnNumber: number
  tokensToWin: number
  /** Player indices who have left or forfeited. */
  out: number[]
  /** Missed turns in a row, per player. */
  missed: number[]
  /** The winning player index, once there is one. */
  winner: number | null
}

export function geometry(arms: number): { track: number; home: number; ring: number } {
  const ring = arms * SEGMENT
  const track = ring - 1
  return { track, home: track + HOME_COLUMN, ring }
}

/** Arms used by a game of `players`: opposite arms for 2, consecutive for 3–4 on the cross, all six for 5–6. */
export function seating(players: number): { arms: 4 | 6; armOf: number[] } {
  switch (players) {
    case 2: return { arms: 4, armOf: [0, 2] }
    case 3: return { arms: 4, armOf: [0, 1, 2] }
    case 4: return { arms: 4, armOf: [0, 1, 2, 3] }
    case 5: return { arms: 6, armOf: [0, 1, 2, 3, 4] }
    case 6: return { arms: 6, armOf: [0, 1, 2, 3, 4, 5] }
    default: throw new Error(`ludo: ${players} players is not a game`)
  }
}

export function newLudo(players: number, tokensToWin = TOKENS, firstPlayer = 0): LudoState {
  const { arms, armOf } = seating(players)
  return {
    arms,
    armOf,
    tokens: armOf.map(() => Array.from({ length: TOKENS }, () => -1)),
    turn: Math.max(0, Math.min(players - 1, Math.trunc(firstPlayer))),
    roll: null,
    sixes: 0,
    step: 0,
    turnNumber: 1,
    tokensToWin: Math.max(1, Math.min(TOKENS, Math.trunc(tokensToWin))),
    out: [],
    missed: armOf.map(() => 0),
    winner: null,
  }
}

/** The main-track square (0 … ring-1) a relative position is on, or null in the yard / home column / home. */
export function absSquare(state: LudoState, player: number, rel: number): number | null {
  const { track, ring } = geometry(state.arms)
  if (rel < 0 || rel >= track) return null
  return (state.armOf[player] * SEGMENT + rel) % ring
}

export function isSafeSquare(arms: number, abs: number): boolean {
  const offset = abs % SEGMENT
  return offset === 0 || offset === 8
}

/** Where token `t` of `player` would land with `die`, or null when that is not a legal move. */
export function target(state: LudoState, player: number, t: number, die: number): number | null {
  const { home } = geometry(state.arms)
  const rel = state.tokens[player][t]
  if (rel === home) return null
  if (rel === -1) return die === 6 ? 0 : null
  const next = rel + die
  return next <= home ? next : null
}

/** The tokens the current player may move with `die`. Tokens on the same square are one move, listed once. */
export function legalMoves(state: LudoState, die: number): number[] {
  const p = state.turn
  const seen = new Set<number>()
  const out: number[] = []
  state.tokens[p].forEach((rel, t) => {
    if (target(state, p, t, die) === null) return
    if (seen.has(rel)) return
    seen.add(rel)
    out.push(t)
  })
  return out
}

function activePlayers(state: LudoState): number[] {
  return state.armOf.map((_, i) => i).filter((i) => !state.out.includes(i))
}

function homeCount(state: LudoState, player: number): number {
  const { home } = geometry(state.arms)
  return state.tokens[player].filter((r) => r === home).length
}

function nextPlayer(state: LudoState, from: number): number {
  const n = state.armOf.length
  for (let k = 1; k <= n; k++) {
    const cand = (from + k) % n
    if (!state.out.includes(cand)) return cand
  }
  return from
}

function clone(s: LudoState): LudoState {
  return { ...s, armOf: [...s.armOf], tokens: s.tokens.map((t) => [...t]), out: [...s.out], missed: [...s.missed] }
}

/**
 * Firestore stores no array directly inside an array, so the match document keeps the tokens FLAT — four per
 * player, in player order — and these two convert at the boundary (functions/src/games/matches.ts). The engine
 * itself always works on `tokens[player][token]`.
 */
export interface StoredLudoState extends Omit<LudoState, 'tokens'> { tokens: number[] }

export function toStored(s: LudoState): StoredLudoState {
  return { ...s, armOf: [...s.armOf], out: [...s.out], missed: [...s.missed], tokens: s.tokens.flat() }
}

export function fromStored(raw: unknown): LudoState {
  const r = raw as StoredLudoState | LudoState
  const t = r.tokens as unknown[]
  if (t.length > 0 && Array.isArray(t[0])) return clone(r as LudoState)
  const flat = t as number[]
  return {
    ...(r as StoredLudoState), armOf: [...r.armOf], out: [...r.out], missed: [...r.missed],
    tokens: r.armOf.map((_, p) => flat.slice(p * TOKENS, p * TOKENS + TOKENS)),
  }
}

/** Pass the turn to the next active player. */
function passTurn(s: LudoState): void {
  s.turn = nextPlayer(s, s.turn)
  s.roll = null
  s.sixes = 0
  s.turnNumber += 1
}

/** The same player goes again. */
function extraTurn(s: LudoState): void {
  s.roll = null
  s.turnNumber += 1
}

function checkLastStanding(s: LudoState): void {
  const left = activePlayers(s)
  if (s.winner === null && left.length === 1) s.winner = left[0]
}

export interface MoveEvent {
  player: number
  token: number
  from: number
  to: number
  captured: Array<{ player: number; token: number; from: number }>
  home: boolean
}

export interface StepResult {
  state: LudoState
  /** What happened, for the screen to animate. */
  event: { kind: 'rolled'; player: number; die: number; passed: boolean; forfeitedTurn: boolean; move?: MoveEvent }
    | { kind: 'moved'; move: MoveEvent }
}

/**
 * The current player rolled `die` (drawn by the server). Applies the three-sixes rule, passes the turn when no
 * move exists, and makes the move for the player when exactly one exists.
 */
export function applyRoll(state: LudoState, die: number): StepResult {
  if (state.winner !== null) throw new Error('ludo: the game is over')
  if (state.roll !== null) throw new Error('ludo: a roll is waiting to be moved')
  if (!Number.isInteger(die) || die < 1 || die > 6) throw new Error(`ludo: bad die ${die}`)
  const s = clone(state)
  s.step += 1
  const player = s.turn
  s.missed[player] = 0
  if (die === 6) s.sixes += 1
  if (die === 6 && s.sixes >= 3) {
    passTurn(s)
    return { state: s, event: { kind: 'rolled', player, die, passed: true, forfeitedTurn: true } }
  }
  const moves = legalMoves(s, die)
  if (moves.length === 0) {
    passTurn(s)
    return { state: s, event: { kind: 'rolled', player, die, passed: true, forfeitedTurn: false } }
  }
  s.roll = die
  if (moves.length === 1) {
    const done = applyMove(s, moves[0])
    return {
      state: done.state,
      event: { kind: 'rolled', player, die, passed: false, forfeitedTurn: false, move: (done.event as { move: MoveEvent }).move },
    }
  }
  return { state: s, event: { kind: 'rolled', player, die, passed: false, forfeitedTurn: false } }
}

/** The current player moves token `t` with the waiting roll. */
export function applyMove(state: LudoState, t: number): StepResult {
  if (state.winner !== null) throw new Error('ludo: the game is over')
  const die = state.roll
  if (die === null) throw new Error('ludo: roll first')
  const player = state.turn
  if (!Number.isInteger(t) || t < 0 || t >= TOKENS) throw new Error(`ludo: bad token ${t}`)
  const to = target(state, player, t, die)
  if (to === null) throw new Error('ludo: that token cannot move')
  const s = clone(state)
  s.step += 1
  const { home } = geometry(s.arms)
  const from = s.tokens[player][t]
  s.tokens[player][t] = to

  const captured: MoveEvent['captured'] = []
  const abs = absSquare(s, player, to)
  if (abs !== null && !isSafeSquare(s.arms, abs)) {
    s.tokens.forEach((toks, other) => {
      if (other === player || s.out.includes(other)) return
      toks.forEach((rel, k) => {
        if (absSquare(s, other, rel) === abs) {
          captured.push({ player: other, token: k, from: rel })
          s.tokens[other][k] = -1
        }
      })
    })
  }
  const reachedHome = to === home
  const move: MoveEvent = { player, token: t, from, to, captured, home: reachedHome }

  if (homeCount(s, player) >= s.tokensToWin) {
    s.winner = player
    s.roll = null
    return { state: s, event: { kind: 'moved', move } }
  }
  if (die === 6 || captured.length > 0 || reachedHome) extraTurn(s)
  else passTurn(s)
  return { state: s, event: { kind: 'moved', move } }
}

/** A player leaves (or is removed for missing turns): their tokens leave the board. */
export function forfeit(state: LudoState, player: number): LudoState {
  if (state.out.includes(player)) return state
  const s = clone(state)
  s.step += 1
  s.out.push(player)
  s.tokens[player] = s.tokens[player].map(() => -1)
  if (s.turn === player && s.winner === null) passTurn(s)
  checkLastStanding(s)
  return s
}

/**
 * The current player's time ran out. The server plays for them — rolls if they had not, then moves the token
 * furthest along — and counts a missed turn; the third in a row forfeits them.
 */
export function timeoutStep(state: LudoState, die: number): StepResult {
  const player = state.turn
  let res: StepResult
  if (state.roll === null) {
    res = applyRoll(state, die)
    // A roll leaves a choice only when several tokens can move: take the most advanced.
    if (res.state.roll !== null && res.state.turn === player && res.state.winner === null) {
      const moves = legalMoves(res.state, res.state.roll)
      const best = moves.reduce((a, b) => (res.state.tokens[player][b] > res.state.tokens[player][a] ? b : a), moves[0])
      res = applyMove(res.state, best)
    }
  } else {
    const moves = legalMoves(state, state.roll)
    const best = moves.reduce((a, b) => (state.tokens[player][b] > state.tokens[player][a] ? b : a), moves[0])
    res = applyMove(state, best)
  }
  const s = clone(res.state)
  s.missed[player] = (state.missed[player] ?? 0) + 1
  if (s.missed[player] >= MAX_MISSED_TURNS && s.winner === null) {
    return { state: forfeit(s, player), event: res.event }
  }
  return { state: s, event: res.event }
}

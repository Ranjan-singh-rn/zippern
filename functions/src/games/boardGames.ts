/**
 * Two more friendly-match games (B4, 3 Nov 2026), pure: Snakes & Ladders (2–4 players, luck) and Four in a Row
 * (2 players, skill). The match layer (matches.ts) escrows the entries, runs the clock and settles; these only say
 * what a move does.
 *
 * SNAKES & LADDERS — Zipper's own board (not any published layout): 100 squares, everybody starts off the board at
 * 0. Roll and move; land on the foot of a ladder and climb, on a snake's head and slide. 100 must be reached
 * exactly — a roll that would pass it leaves the token where it is. First to 100 wins. A turn not taken in time is
 * rolled by the server and counted as a miss; three misses in a row and the player is out. Leaving is going out.
 *
 * FOUR IN A ROW — 7 columns × 6 rows. Drop a disc; it falls to the lowest empty cell. Four of yours in a line —
 * across, up, or diagonally — wins. A full board with no line is a draw: the pool (less the fee) is shared. A turn
 * not taken in time: the server drops a disc in a column drawn from the match seed and counts a miss; a second miss
 * in a row forfeits the game.
 */

// ══════════════════════════════════════════════════════════════════════════════
//  Snakes & Ladders
// ══════════════════════════════════════════════════════════════════════════════

export const FINISH = 100
export const LADDERS: Readonly<Record<number, number>> = { 3: 20, 6: 27, 11: 33, 24: 45, 37: 58, 42: 63, 55: 74, 68: 87, 79: 96 }
export const SNAKES: Readonly<Record<number, number>> = { 17: 4, 29: 9, 47: 21, 53: 34, 66: 48, 77: 57, 85: 64, 91: 70, 97: 78, 99: 81 }
export const SNAKES_MISSES_OUT = 3

export interface SnakesState {
  players: number
  positions: number[]
  turn: number
  step: number
  turnNumber: number
  misses: number[]
  out: boolean[]
  winner: number | null
}

export interface SnakesEvent {
  player: number
  die: number
  from: number
  /** Where the roll put the token before any ladder or snake. */
  landed: number
  to: number
  via: 'ladder' | 'snake' | null
  /** The roll would have passed 100: the token stayed. */
  stayed: boolean
  timedOut?: boolean
}

export function newSnakes(players: number, firstPlayer = 0): SnakesState {
  if (players < 2 || players > 4) throw new Error('snakes: 2 to 4 players')
  return {
    players, positions: Array.from({ length: players }, () => 0), turn: firstPlayer % players, step: 0, turnNumber: 1,
    misses: Array.from({ length: players }, () => 0), out: Array.from({ length: players }, () => false), winner: null,
  }
}

function cloneS(s: SnakesState): SnakesState {
  return { ...s, positions: [...s.positions], misses: [...s.misses], out: [...s.out] }
}

function passS(s: SnakesState): void {
  for (let k = 1; k <= s.players; k++) {
    const c = (s.turn + k) % s.players
    if (!s.out[c]) { s.turn = c; break }
  }
  s.turnNumber += 1
}

function lastStandingS(s: SnakesState): void {
  const live = s.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0)
  if (live.length === 1) s.winner = live[0]
}

/** The current player rolls `die` (1…6, drawn by the server). */
export function snakesRoll(state: SnakesState, player: number, die: number): { state: SnakesState; event: SnakesEvent } {
  if (state.winner !== null) throw new Error('snakes: the game is over')
  if (state.turn !== player) throw new Error('snakes: it is not your turn')
  if (!(Number.isInteger(die) && die >= 1 && die <= 6)) throw new Error('snakes: bad die')
  const s = cloneS(state)
  s.step += 1
  s.misses[player] = 0                    // a roll the player made resets their misses (a timeout sets them after)
  const from = s.positions[player]
  const target = from + die
  let event: SnakesEvent
  if (target > FINISH) {
    event = { player, die, from, landed: from, to: from, via: null, stayed: true }
  } else {
    const up = LADDERS[target]
    const down = SNAKES[target]
    const to = up ?? down ?? target
    s.positions[player] = to
    event = { player, die, from, landed: target, to, via: up ? 'ladder' : down ? 'snake' : null, stayed: false }
  }
  if (s.positions[player] === FINISH) s.winner = player
  else passS(s)
  return { state: s, event }
}

/** A turn not taken in time: the server rolls for the absent player, then counts the miss. */
export function snakesTimeout(state: SnakesState, die: number): { state: SnakesState; event: SnakesEvent } {
  const p = state.turn
  const r = snakesRoll(state, p, die)
  const s = r.state
  if (s.winner === null) {
    s.misses[p] = state.misses[p] + 1
    if (s.misses[p] >= SNAKES_MISSES_OUT) {
      s.out[p] = true
      lastStandingS(s)
    }
  }
  return { state: s, event: { ...r.event, timedOut: true } }
}

export function snakesForfeit(state: SnakesState, player: number): SnakesState {
  if (state.winner !== null || state.out[player]) return state
  const s = cloneS(state)
  s.step += 1
  s.out[player] = true
  lastStandingS(s)
  if (s.winner === null && s.turn === player) passS(s)
  return s
}

// ══════════════════════════════════════════════════════════════════════════════
//  Four in a Row
// ══════════════════════════════════════════════════════════════════════════════

export const COLS = 7
export const ROWS = 6
export const FOUR_MISSES_OUT = 2

export interface FourRowState {
  /** 42 cells, row by row from the BOTTOM: index = row × 7 + col; −1 empty, else the player (0 or 1). */
  cells: number[]
  turn: number
  step: number
  turnNumber: number
  misses: number[]
  /** [player] for a win, [0, 1] for a draw. */
  winners: number[] | null
  endedBy: 'four' | 'draw' | 'forfeit' | null
  /** The winning four, as cell indices. */
  line: number[] | null
}

export interface FourRowEvent { player: number; col: number; row: number; timedOut?: boolean }

export function newFourRow(firstPlayer = 0): FourRowState {
  return {
    cells: Array.from({ length: COLS * ROWS }, () => -1), turn: firstPlayer % 2, step: 0, turnNumber: 1,
    misses: [0, 0], winners: null, endedBy: null, line: null,
  }
}

export function legalColumns(s: FourRowState): number[] {
  return Array.from({ length: COLS }, (_, c) => c).filter((c) => s.cells[(ROWS - 1) * COLS + c] === -1)
}

/** The four in a line through (row, col) for `player`, or null. */
export function fourThrough(cells: number[], row: number, col: number, player: number): number[] | null {
  const at = (r: number, c: number) => (r >= 0 && r < ROWS && c >= 0 && c < COLS ? cells[r * COLS + c] : -2)
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const line = [row * COLS + col]
    for (const sign of [1, -1]) {
      let r = row + dr * sign
      let c = col + dc * sign
      while (at(r, c) === player) { line.push(r * COLS + c); r += dr * sign; c += dc * sign }
    }
    if (line.length >= 4) return line.sort((a, b) => a - b)
  }
  return null
}

export function fourRowDrop(state: FourRowState, player: number, col: number): { state: FourRowState; event: FourRowEvent } {
  if (state.winners) throw new Error('four in a row: the game is over')
  if (state.turn !== player) throw new Error('four in a row: it is not your turn')
  if (!(Number.isInteger(col) && col >= 0 && col < COLS)) throw new Error('four in a row: choose a column')
  let row = -1
  for (let r = 0; r < ROWS; r++) if (state.cells[r * COLS + col] === -1) { row = r; break }
  if (row < 0) throw new Error('four in a row: that column is full')
  const s: FourRowState = { ...state, cells: [...state.cells], misses: [...state.misses], winners: null, line: null }
  s.misses[player] = 0                    // a move the player made resets their misses (a timeout sets them after)
  s.cells[row * COLS + col] = player
  s.step += 1
  const line = fourThrough(s.cells, row, col, player)
  if (line) {
    s.winners = [player]
    s.endedBy = 'four'
    s.line = line
  } else if (s.cells.every((c) => c !== -1)) {
    s.winners = [0, 1]
    s.endedBy = 'draw'
  } else {
    s.turn = 1 - player
    s.turnNumber += 1
  }
  return { state: s, event: { player, col, row } }
}

/**
 * A turn not taken in time: the second miss in a row forfeits; otherwise the server drops in the column at
 * `pickIndex` of the legal columns (drawn from the match seed) and counts the miss.
 */
export function fourRowTimeout(state: FourRowState, pickIndex: number): { state: FourRowState; event: FourRowEvent | null } {
  const p = state.turn
  if (state.misses[p] + 1 >= FOUR_MISSES_OUT) return { state: fourRowForfeit(state, p), event: null }
  const cols = legalColumns(state)
  const r = fourRowDrop(state, p, cols[((pickIndex % cols.length) + cols.length) % cols.length])
  r.state.misses = r.state.misses.map((m, i) => (i === p ? state.misses[p] + 1 : m))
  return { state: r.state, event: { ...r.event, timedOut: true } }
}

export function fourRowForfeit(state: FourRowState, player: number): FourRowState {
  if (state.winners) return state
  return { ...state, cells: [...state.cells], misses: [...state.misses], step: state.step + 1, winners: [1 - player], endedBy: 'forfeit', line: null }
}

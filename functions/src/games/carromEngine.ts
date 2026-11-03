/**
 * CARROM — the board physics and Zipper's table rules, pure (B4, 3 Nov 2026). The server simulates every shot;
 * the phones only replay the frames it returns, so nobody's device decides where a piece stops.
 *
 * Rules (Zipper "Freestyle" carrom, 2–4 players, each from their own side of the board):
 *   * 9 white (20 points each), 9 black (10 points each) and the queen (50 points).
 *   * On your turn you place the striker on your baseline, aim and shoot.
 *   * Pocket anything and you shoot again. Pocket nothing and the turn passes.
 *   * The queen must be COVERED: pocket a white or black in the same shot or in your next shot. Then it scores 50;
 *     if you miss the cover it goes back to the centre. (With no white or black left on the board it counts at once.)
 *   * Pocketing the striker is a FOUL: minus 10 points (never below 0), whatever you pocketed in that shot goes
 *     back to the centre, a queen waiting for cover goes back too, and the turn passes.
 *   * The first to the target (default 160 points) wins at once. If the board is cleared first, or every player has
 *     used their shots (default 25 each), the highest score wins; equal top scores share the prize.
 *   * A turn not taken in time passes (a miss); three misses and you are out. Leaving is going out. The last player
 *     not out wins.
 *
 * Geometry (millimetres, y down — the way a phone draws): the playing surface is 740 × 740, pockets in the corners.
 * Side 0 is the bottom edge; sides 1, 2, 3 are the board turned a quarter clockwise each time (left, top, right).
 * A shot is sent in the shooter's own view (their side at the bottom): x01 along their baseline (0 = left end,
 * 1 = right end), the angle as atan2(dy, dx) in that view, power 0…1. The server turns it onto the board.
 */

export const BOARD = 740
export const CENTER = BOARD / 2
export const PIECE_R = 15.9
export const STRIKER_R = 20.65
const PIECE_M = 5.5
const STRIKER_M = 15
export const POCKET_R = 24
export const POCKETS: ReadonlyArray<readonly [number, number]> = [
  [22, 22], [BOARD - 22, 22], [BOARD - 22, BOARD - 22], [22, BOARD - 22],
]
/** The baseline in the shooter's view: `v` from their edge, `u` from uMin to uMax along it. */
export const BASELINE = { v: 105, uMin: 175, uMax: 565 }
export const MIN_SPEED = 250
export const MAX_SPEED = 2800
export const POINTS = { white: 20, black: 10, queen: 50 } as const
export const FOUL_PENALTY = 10
export const MISSES_OUT = 3

const DT = 0.001          // s — one physics step
const DECEL = 700         // mm/s² — sliding friction
const DAMP = 0.6          // 1/s — speed-proportional drag
const WALL_E = 0.62       // cushion restitution
const BODY_E = 0.9        // piece-on-piece restitution
const MAX_STEPS = 12_000  // 12 s, then everything is stopped where it is
export const FRAME_MS = 50 // one replay frame every 50 ms

export type PieceKind = 'white' | 'black' | 'queen'

export interface CarromPiece { kind: PieceKind; x: number; y: number; on: boolean }

interface Body { x: number; y: number; vx: number; vy: number; r: number; m: number; on: boolean }

export interface SimResult {
  /** Positions every FRAME_MS: per frame, [x, y] of every body (striker first) rounded to mm; −1, −1 once pocketed. */
  frames: number[][]
  /** Which body fell into which pocket, at which frame. */
  pocketed: Array<{ body: number; pocket: number; frame: number }>
  bodies: Body[]
}

// ══════════════════════════════════════════════════════════════════════════════
//  Physics
// ══════════════════════════════════════════════════════════════════════════════

function frameOf(bodies: Body[]): number[] {
  const out: number[] = []
  for (const b of bodies) {
    if (b.on) out.push(Math.round(b.x), Math.round(b.y))
    else out.push(-1, -1)
  }
  return out
}

/** Run one shot to rest. Deterministic: the same bodies and velocities give the same result, every time. */
export function simulate(start: Body[]): SimResult {
  const bodies = start.map((b) => ({ ...b }))
  const frames: number[][] = [frameOf(bodies)]
  const pocketed: SimResult['pocketed'] = []
  const n = bodies.length
  let step = 0
  for (; step < MAX_STEPS; step++) {
    let moving = false
    // Friction, then move.
    for (const b of bodies) {
      if (!b.on) continue
      const sp = Math.hypot(b.vx, b.vy)
      if (sp === 0) continue
      const drop = DECEL * DT + DAMP * sp * DT
      if (sp <= drop) { b.vx = 0; b.vy = 0; continue }
      const k = (sp - drop) / sp
      b.vx *= k
      b.vy *= k
      b.x += b.vx * DT
      b.y += b.vy * DT
      moving = true
    }
    // Pockets before cushions, so a piece running into a corner drops instead of bouncing out.
    for (let i = 0; i < n; i++) {
      const b = bodies[i]
      if (!b.on) continue
      for (let p = 0; p < POCKETS.length; p++) {
        const [px, py] = POCKETS[p]
        if (Math.hypot(b.x - px, b.y - py) < POCKET_R) {
          b.on = false
          b.vx = 0
          b.vy = 0
          pocketed.push({ body: i, pocket: p, frame: Math.ceil((step + 1) / FRAME_MS) })
          break
        }
      }
    }
    // Cushions.
    for (const b of bodies) {
      if (!b.on) continue
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * WALL_E; b.vy *= 0.97 }
      else if (b.x > BOARD - b.r) { b.x = BOARD - b.r; b.vx = -Math.abs(b.vx) * WALL_E; b.vy *= 0.97 }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * WALL_E; b.vx *= 0.97 }
      else if (b.y > BOARD - b.r) { b.y = BOARD - b.r; b.vy = -Math.abs(b.vy) * WALL_E; b.vx *= 0.97 }
    }
    // Collisions (only pairs where something moves).
    for (let i = 0; i < n; i++) {
      const a = bodies[i]
      if (!a.on) continue
      for (let j = i + 1; j < n; j++) {
        const c = bodies[j]
        if (!c.on) continue
        if (a.vx === 0 && a.vy === 0 && c.vx === 0 && c.vy === 0) continue
        const dx = c.x - a.x
        const dy = c.y - a.y
        const rr = a.r + c.r
        const d2 = dx * dx + dy * dy
        if (d2 >= rr * rr) continue
        let d = Math.sqrt(d2)
        let nx: number
        let ny: number
        if (d === 0) { nx = 1; ny = 0; d = 0 } else { nx = dx / d; ny = dy / d }
        const invA = 1 / a.m
        const invC = 1 / c.m
        const vn = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny
        if (vn < 0) {
          const J = (-(1 + BODY_E) * vn) / (invA + invC)
          a.vx -= J * invA * nx
          a.vy -= J * invA * ny
          c.vx += J * invC * nx
          c.vy += J * invC * ny
        }
        const overlap = rr - d
        const share = overlap / (invA + invC)
        a.x -= nx * share * invA
        a.y -= ny * share * invA
        c.x += nx * share * invC
        c.y += ny * share * invC
      }
    }
    if ((step + 1) % FRAME_MS === 0) frames.push(frameOf(bodies))
    if (!moving) break
  }
  for (const b of bodies) { b.vx = 0; b.vy = 0 }
  const last = frameOf(bodies)
  if (frames[frames.length - 1].join() !== last.join()) frames.push(last)
  return { frames, pocketed, bodies }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Board geometry
// ══════════════════════════════════════════════════════════════════════════════

/** Turn a board point a quarter clockwise (on a y-down screen) `k` times about the centre. */
export function rotate(x: number, y: number, k: number): [number, number] {
  let px = x
  let py = y
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) {
    const nx = CENTER - (py - CENTER)
    const ny = CENTER + (px - CENTER)
    px = nx
    py = ny
  }
  return [px, py]
}

/** Board sides by table size: two players face each other. */
export function sidesFor(players: number): number[] {
  if (players === 2) return [0, 2]
  if (players === 3) return [0, 1, 2]
  if (players === 4) return [0, 1, 2, 3]
  throw new Error('carrom: 2 to 4 players')
}

/** The opening position: the queen in the middle, a ring of six, a ring of twelve; 9 white, 9 black. */
export function openingPieces(): CarromPiece[] {
  const d = 2 * PIECE_R + 0.4
  const at = (dist: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [CENTER + dist * Math.cos(a), CENTER + dist * Math.sin(a)]
  }
  const whites: Array<[number, number]> = []
  const blacks: Array<[number, number]> = []
  for (let k = 0; k < 6; k++) {
    ;(k % 2 === 0 ? whites : blacks).push(at(d, k * 60))
    ;(k % 2 === 0 ? blacks : whites).push(at(2 * d, k * 60))
    ;(k % 2 === 0 ? whites : blacks).push(at(Math.sqrt(3) * d, 30 + k * 60))
  }
  return [
    { kind: 'queen', x: CENTER, y: CENTER, on: true },
    ...whites.map(([x, y]) => ({ kind: 'white' as const, x, y, on: true })),
    ...blacks.map(([x, y]) => ({ kind: 'black' as const, x, y, on: true })),
  ]
}

/** The nearest free spot to the centre for a returned piece (a fixed spiral — the same answer every time). */
export function freeSpotNearCentre(pieces: CarromPiece[], r = PIECE_R): [number, number] {
  const clear = (x: number, y: number) => pieces.every((p) => !p.on || Math.hypot(p.x - x, p.y - y) >= r + PIECE_R + 0.2)
  if (clear(CENTER, CENTER)) return [CENTER, CENTER]
  for (let rad = 4; rad < 320; rad += 4) {
    const n = Math.max(6, Math.floor((2 * Math.PI * rad) / 8))
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n
      const x = CENTER + rad * Math.cos(a)
      const y = CENTER + rad * Math.sin(a)
      if (clear(x, y)) return [x, y]
    }
  }
  return [CENTER, CENTER]
}

// ══════════════════════════════════════════════════════════════════════════════
//  The table
// ══════════════════════════════════════════════════════════════════════════════

export interface CarromState {
  players: number
  sides: number[]
  /** 0 = the queen, 1…9 white, 10…18 black. */
  pieces: CarromPiece[]
  scores: number[]
  misses: number[]
  out: boolean[]
  turn: number
  step: number
  turnNumber: number
  shots: number
  maxShots: number
  target: number
  /** The queen is in a pocket waiting for this player to cover it. */
  queenPendingBy: number | null
  winners: number[] | null
  /** 'target' | 'cleared' | 'shots' | 'last_player' */
  endedBy: string | null
}

export function newCarrom(players: number, firstPlayer = 0, target = 160, shotsPerPlayer = 25): CarromState {
  const sides = sidesFor(players)
  return {
    players, sides, pieces: openingPieces(),
    scores: sides.map(() => 0), misses: sides.map(() => 0), out: sides.map(() => false),
    turn: firstPlayer % players, step: 0, turnNumber: 1, shots: 0,
    maxShots: players * Math.max(5, Math.trunc(shotsPerPlayer)), target: Math.max(20, Math.trunc(target)),
    queenPendingBy: null, winners: null, endedBy: null,
  }
}

function clone(s: CarromState): CarromState {
  return {
    ...s, sides: [...s.sides], pieces: s.pieces.map((p) => ({ ...p })), scores: [...s.scores], misses: [...s.misses],
    out: [...s.out], winners: s.winners ? [...s.winners] : null,
  }
}

function inPlay(s: CarromState): number[] {
  return s.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0)
}

function passTurn(s: CarromState): void {
  for (let k = 1; k <= s.players; k++) {
    const c = (s.turn + k) % s.players
    if (!s.out[c]) { s.turn = c; break }
  }
  s.turnNumber += 1
}

function returnToCentre(s: CarromState, index: number): void {
  const [x, y] = freeSpotNearCentre(s.pieces)
  s.pieces[index] = { ...s.pieces[index], x, y, on: true }
}

function topScorers(s: CarromState): number[] {
  const live = inPlay(s)
  const best = Math.max(...live.map((i) => s.scores[i]))
  return live.filter((i) => s.scores[i] === best)
}

/** The striker's centre on the board for a player's chosen spot on their baseline. */
export function strikerAt(s: CarromState, player: number, x01: number): [number, number] {
  const u = BASELINE.uMin + Math.min(1, Math.max(0, x01)) * (BASELINE.uMax - BASELINE.uMin)
  return rotate(u, BOARD - BASELINE.v, s.sides[player])
}

export interface Shot { x01: number; angle: number; power: number }

export interface ShotResult {
  state: CarromState
  event: Record<string, unknown>
  frames: number[][]
  pocketed: SimResult['pocketed']
}

export function shoot(state: CarromState, player: number, shot: Shot): ShotResult {
  if (state.winners) throw new Error('carrom: the game is over')
  if (state.turn !== player) throw new Error('carrom: it is not your turn')
  const { x01, angle, power } = shot
  if (![x01, angle, power].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error('carrom: aim and shoot')
  if (x01 < 0 || x01 > 1 || power < 0 || power > 1) throw new Error('carrom: aim and shoot')
  const [sx, sy] = strikerAt(state, player, x01)
  if (state.pieces.some((p) => p.on && Math.hypot(p.x - sx, p.y - sy) < STRIKER_R + PIECE_R)) {
    throw new Error('carrom: the striker is on a piece — move it along the line')
  }
  const theta = angle + (state.sides[player] * Math.PI) / 2
  const speed = MIN_SPEED + power * (MAX_SPEED - MIN_SPEED)
  const bodies: Body[] = [
    { x: sx, y: sy, vx: Math.cos(theta) * speed, vy: Math.sin(theta) * speed, r: STRIKER_R, m: STRIKER_M, on: true },
    ...state.pieces.map((p) => ({ x: p.x, y: p.y, vx: 0, vy: 0, r: PIECE_R, m: PIECE_M, on: p.on })),
  ]
  const sim = simulate(bodies)

  const s = clone(state)
  s.step += 1
  s.shots += 1
  s.misses[player] = 0
  const now: number[] = []
  sim.bodies.slice(1).forEach((b, i) => {
    s.pieces[i] = { ...s.pieces[i], x: b.x, y: b.y, on: b.on }
    if (state.pieces[i].on && !b.on) now.push(i)
  })
  const foul = !sim.bodies[0].on
  const kinds = now.map((i) => s.pieces[i].kind)
  let points = 0
  let queen: string | null = null
  let again = false

  if (foul) {
    for (const i of now) returnToCentre(s, i)
    if (s.queenPendingBy === player) { returnToCentre(s, 0); queen = 'returned' }
    s.queenPendingBy = null
    points = -Math.min(FOUL_PENALTY, s.scores[player])
  } else {
    const plain = now.filter((i) => i !== 0)
    for (const i of plain) points += POINTS[s.pieces[i].kind]
    const plainLeft = s.pieces.some((p) => p.on && p.kind !== 'queen')
    if (now.includes(0)) {
      if (plain.length > 0 || !plainLeft) { points += POINTS.queen; queen = 'covered' } else { s.queenPendingBy = player; queen = 'pending' }
    } else if (s.queenPendingBy === player) {
      if (plain.length > 0) { points += POINTS.queen; queen = 'covered' } else { returnToCentre(s, 0); queen = 'returned' }
      s.queenPendingBy = null
    }
    again = now.length > 0
  }
  s.scores[player] += points

  const event = { player, pocketed: kinds, foul, points, again, queen }
  // The end.
  if (s.scores[player] >= s.target && !foul) {
    s.winners = [player]
    s.endedBy = 'target'
  } else if (s.pieces.every((p) => !p.on) && s.queenPendingBy === null) {
    s.winners = topScorers(s)
    s.endedBy = 'cleared'
  } else if (s.shots >= s.maxShots) {
    s.winners = topScorers(s)
    s.endedBy = 'shots'
  } else if (!again) {
    passTurn(s)
  }
  return { state: s, event, frames: sim.frames, pocketed: sim.pocketed }
}

function endIfOneLeft(s: CarromState): void {
  const live = inPlay(s)
  if (live.length === 1) { s.winners = live; s.endedBy = 'last_player' }
}

/** A turn not taken in time passes; the third miss in a row puts the player out. */
export function timeoutPass(state: CarromState): CarromState {
  if (state.winners) return state
  const s = clone(state)
  const p = s.turn
  s.step += 1
  s.misses[p] += 1
  if (s.queenPendingBy === p) { returnToCentre(s, 0); s.queenPendingBy = null }
  if (s.misses[p] >= MISSES_OUT) s.out[p] = true
  endIfOneLeft(s)
  if (!s.winners) passTurn(s)
  return s
}

/** A player who leaves is out; if it was their turn, play moves on. */
export function forfeit(state: CarromState, player: number): CarromState {
  if (state.winners || state.out[player]) return state
  const s = clone(state)
  s.step += 1
  s.out[player] = true
  if (s.queenPendingBy === player) { returnToCentre(s, 0); s.queenPendingBy = null }
  endIfOneLeft(s)
  if (!s.winners && s.turn === player) passTurn(s)
  return s
}

/** Frames packed for the match document: little-endian int16 values, base64 (Firestore has no nested arrays). */
export function packFrames(frames: number[][]): string {
  const values = frames.flat()
  const buf = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2))
  return buf.toString('base64')
}

export function unpackFrames(b64: string, bodies: number): number[][] {
  const buf = Buffer.from(b64, 'base64')
  const stride = bodies * 2
  const out: number[][] = []
  for (let off = 0; off + stride * 2 <= buf.length; off += stride * 2) {
    const f: number[] = []
    for (let k = 0; k < stride; k++) f.push(buf.readInt16LE(off + k * 2))
    out.push(f)
  }
  return out
}

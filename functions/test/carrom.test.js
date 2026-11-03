/**
 * B4 (3 Nov 2026) — Carrom: the board physics and table rules (pure engine) and the SHIPPED callables
 * (lib/games/matches.js) over the in-memory Firestore in optimistic-transaction mode.
 *
 * The server simulates every shot; the phones replay the frames it stores. The rules pinned here: pocket and shoot
 * again; the queen must be covered; pocketing the striker is a foul (−10, the shot's pieces come back); first to the
 * target wins; three missed turns and you are out. The money: 100 + 100 → winner 150, Zipper 50, zero difference.
 *
 * Run:  node --test test/carrom.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const G = require('../lib/games/matches')
const CR = require('../lib/games/carromEngine')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let keyN = 0
const key = () => `key-${++keyN}-abcdefgh`

// ─────────────────────────────────────────────────────────────────────────────
// Engine helpers: a near-empty board with pieces exactly where a test wants them.

/** A 2-player table, seat 0 to shoot, with only the given pieces on the board (index → {kind,x,y}). */
function bare(over = {}, extra = {}) {
  const s = CR.newCarrom(2, 0)
  s.pieces = s.pieces.map((p) => ({ ...p, on: false }))
  for (const [i, p] of Object.entries(over)) s.pieces[Number(i)] = { ...p, on: true }
  return { ...s, ...extra }
}
const STRIKER = CR.strikerAt(CR.newCarrom(2, 0), 0, 0)           // seat 0, far left of the baseline
const TOP_LEFT = CR.POCKETS[0]
const AIM = Math.atan2(TOP_LEFT[1] - STRIKER[1], TOP_LEFT[0] - STRIKER[0])
/** A point 60% of the way from the striker to the top-left pocket — a piece there drops at power 0.3–0.5. */
const ON_LINE = [STRIKER[0] + 0.6 * (TOP_LEFT[0] - STRIKER[0]), STRIKER[1] + 0.6 * (TOP_LEFT[1] - STRIKER[1])]
const FAR_BLACK = { kind: 'black', x: 600, y: 300 }

describe('the board', () => {
  test('opening: the queen, 9 white, 9 black, none touching, centred', () => {
    const p = CR.openingPieces()
    expect(p.length).toBe(19)
    expect(p.filter((x) => x.kind === 'white').length).toBe(9)
    expect(p.filter((x) => x.kind === 'black').length).toBe(9)
    expect(p[0]).toEqual({ kind: 'queen', x: 370, y: 370, on: true })
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      expect(Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y) >= 2 * CR.PIECE_R).toBe(true)
    }
    const cx = p.reduce((a, x) => a + x.x, 0) / 19
    expect(Math.abs(cx - 370) < 1e-9).toBe(true)
  })
  test('sides: two players face each other; the board turns a quarter per side', () => {
    expect(CR.sidesFor(2)).toEqual([0, 2])
    expect(CR.sidesFor(4)).toEqual([0, 1, 2, 3])
    expect(() => CR.sidesFor(5)).toThrow('2 to 4')
    expect(CR.rotate(123, 456, 4)).toEqual([123, 456])
    const s = CR.newCarrom(2, 0)
    expect(CR.strikerAt(s, 0, 0)).toEqual([175, 635])
    expect(CR.strikerAt(s, 1, 0)).toEqual([565, 105])              // the top player's left is the board's right
  })
  test('a shot is deterministic, nothing leaves the table, nothing overlaps at rest; frames pack and unpack', () => {
    const s = CR.newCarrom(2, 0)
    const a = CR.shoot(s, 0, { x01: 0.5, angle: -Math.PI / 2, power: 1 })
    const b = CR.shoot(s, 0, { x01: 0.5, angle: -Math.PI / 2, power: 1 })
    expect(JSON.stringify(a.frames)).toBe(JSON.stringify(b.frames))
    const on = a.state.pieces.filter((p) => p.on)
    for (const p of on) {
      expect(p.x >= CR.PIECE_R - 1e-6 && p.x <= CR.BOARD - CR.PIECE_R + 1e-6).toBe(true)
      expect(p.y >= CR.PIECE_R - 1e-6 && p.y <= CR.BOARD - CR.PIECE_R + 1e-6).toBe(true)
    }
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      expect(Math.hypot(on[i].x - on[j].x, on[i].y - on[j].y) > 2 * CR.PIECE_R - 0.5).toBe(true)
    }
    expect(a.frames.length > 5).toBe(true)
    expect(a.frames[0].length).toBe(40)                              // striker + 19 pieces, x and y
    expect(CR.unpackFrames(CR.packFrames(a.frames), 20)).toEqual(a.frames)
    // The break moves the pack.
    expect(a.state.pieces.some((p, i) => Math.hypot(p.x - s.pieces[i].x, p.y - s.pieces[i].y) > 50)).toBe(true)
  })
})

describe('the rules', () => {
  test('pocket a white: +20 and shoot again', () => {
    const s = bare({ 1: { kind: 'white', x: ON_LINE[0], y: ON_LINE[1] }, 10: FAR_BLACK })
    const r = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(r.event).toMatchObject({ pocketed: ['white'], foul: false, points: 20, again: true })
    expect(r.state.scores).toEqual([20, 0])
    expect(r.state.turn).toBe(0)
    expect(r.pocketed.some((x) => x.body === 2 && x.pocket === 0)).toBe(true)   // body 2 = piece 1
  })
  test('too hard — the striker follows it in: a foul, −10, the white comes back, the turn passes', () => {
    const s = bare({ 1: { kind: 'white', x: ON_LINE[0], y: ON_LINE[1] }, 10: FAR_BLACK }, { scores: [30, 0] })
    const r = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 1 })
    expect(r.event).toMatchObject({ pocketed: ['white'], foul: true, points: -10, again: false })
    expect(r.state.scores).toEqual([20, 0])
    expect(r.state.pieces[1].on).toBe(true)
    expect(Math.hypot(r.state.pieces[1].x - 370, r.state.pieces[1].y - 370) < 40).toBe(true)
    expect(r.state.turn).toBe(1)
  })
  test('a foul never takes a score below zero', () => {
    const s = bare({ 10: FAR_BLACK })
    const pocket = CR.POCKETS[3]
    const r = CR.shoot(s, 0, { x01: 0, angle: Math.atan2(pocket[1] - STRIKER[1], pocket[0] - STRIKER[0]), power: 0.4 })
    expect(r.event.foul).toBe(true)
    expect(r.state.scores).toEqual([0, 0])
    expect(r.state.turn).toBe(1)
  })
  test('the queen alone waits for cover; pocket nothing next and she goes back to the centre', () => {
    const s = bare({ 0: { kind: 'queen', x: ON_LINE[0], y: ON_LINE[1] }, 10: FAR_BLACK })
    const r1 = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(r1.event).toMatchObject({ pocketed: ['queen'], queen: 'pending', points: 0, again: true })
    expect(r1.state.queenPendingBy).toBe(0)
    const r2 = CR.shoot(r1.state, 0, { x01: 0, angle: AIM, power: 0.2 })
    expect(r2.event).toMatchObject({ pocketed: [], queen: 'returned', points: 0, again: false })
    expect(r2.state.pieces[0].on).toBe(true)
    expect(r2.state.queenPendingBy).toBe(null)
    expect(r2.state.turn).toBe(1)
  })
  test('the queen covered on the next shot: +50 with the white\'s +20', () => {
    const s = bare({ 0: { kind: 'queen', x: ON_LINE[0], y: ON_LINE[1] }, 10: FAR_BLACK })
    const r1 = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 0.4 })
    const next = { ...r1.state, pieces: r1.state.pieces.map((p) => ({ ...p })) }
    next.pieces[1] = { kind: 'white', x: ON_LINE[0], y: ON_LINE[1], on: true }
    const r2 = CR.shoot(next, 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(r2.event).toMatchObject({ pocketed: ['white'], queen: 'covered', points: 70, again: true })
    expect(r2.state.scores[0]).toBe(70)
  })
  test('the target ends the game at once', () => {
    const s = bare({ 1: { kind: 'white', x: ON_LINE[0], y: ON_LINE[1] }, 10: FAR_BLACK }, { target: 20 })
    const r = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(r.state.winners).toEqual([0])
    expect(r.state.endedBy).toBe('target')
  })
  test('the board cleared: the highest score wins; equal top scores share', () => {
    const s = bare({ 1: { kind: 'white', x: ON_LINE[0], y: ON_LINE[1] } }, { scores: [0, 40] })
    const r = CR.shoot(s, 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(r.state.endedBy).toBe('cleared')
    expect(r.state.winners).toEqual([1])                                        // 20 against 40
    const tie = CR.shoot(bare({ 1: { kind: 'white', x: ON_LINE[0], y: ON_LINE[1] } }, { scores: [20, 40] }), 0, { x01: 0, angle: AIM, power: 0.4 })
    expect(tie.state.winners).toEqual([0, 1])
  })
  test('every shot used: the highest score wins', () => {
    const s = bare({ 10: FAR_BLACK }, { maxShots: 1, scores: [10, 0] })
    const r = CR.shoot(s, 0, { x01: 0.5, angle: -Math.PI / 2, power: 0.1 })
    expect(r.state.endedBy).toBe('shots')
    expect(r.state.winners).toEqual([0])
  })
  test('bad shots are refused: out of turn, nonsense, the striker on a piece', () => {
    const s = CR.newCarrom(2, 0)
    expect(() => CR.shoot(s, 1, { x01: 0.5, angle: 0, power: 0.5 })).toThrow('not your turn')
    expect(() => CR.shoot(s, 0, { x01: 2, angle: 0, power: 0.5 })).toThrow('aim and shoot')
    expect(() => CR.shoot(s, 0, { x01: 0.5, angle: NaN, power: 0.5 })).toThrow('aim and shoot')
    const blocked = bare({ 10: { kind: 'black', x: STRIKER[0] + 10, y: STRIKER[1] } })
    expect(() => CR.shoot(blocked, 0, { x01: 0, angle: AIM, power: 0.5 })).toThrow('striker is on a piece')
  })
  test('three missed turns put a player out; with two players the other wins', () => {
    let s = CR.newCarrom(2, 0)
    s = CR.timeoutPass(s)                      // seat 0: 1
    expect(s.turn).toBe(1)
    s = CR.timeoutPass(s)                      // seat 1: 1
    s = CR.timeoutPass(s)                      // seat 0: 2
    const shot = CR.shoot(s, 1, { x01: 0.5, angle: -Math.PI / 2, power: 0.2 })   // seat 1 plays: its misses reset
    expect(shot.state.misses[1]).toBe(0)
    s = CR.timeoutPass(shot.state.turn === 0 ? shot.state : CR.timeoutPass(shot.state))
    expect(s.out[0]).toBe(true)
    expect(s.winners).toEqual([1])
    expect(s.endedBy).toBe('last_player')
  })
  test('leaving in a four-player game: out, and play goes on', () => {
    const s = CR.newCarrom(4, 0)
    const f = CR.forfeit(s, 0)
    expect(f.out).toEqual([true, false, false, false])
    expect(f.turn).toBe(1)
    expect(f.winners).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const ON = {
  enabled: true,
  games: { carrom: { enabled: true, entryOptions: [100], platformFeePct: 25, modes: [2, 4, 6], turnSeconds: 45, waitMinutes: 10, shotsPerPlayer: 5 } },
}
const diamonds = (uid) => db.read(`users/${uid}`).diamonds
const match = (id) => db.read(`gameMatches/${id}`)
const ledger = (id) => db.all('gameLedger').filter((r) => r.matchId === id)
const sumKind = (id, k) => ledger(id).filter((x) => x.kind === k).reduce((a, x) => a + x.diamonds, 0)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  for (const u of ['A', 'B', 'C', 'D', 'E', 'F']) db.seed(`users/${u}`, { name: u, diamonds: 1000 })
})

async function table(players = 2) {
  const made = await call(G.createGameMatch, 'A', { gameId: 'carrom', players, entry: 100, idempotencyKey: key() })
  for (const u of ['B', 'C', 'D'].slice(0, players - 1)) await call(G.joinGameMatch, u, { matchId: made.matchId, idempotencyKey: key() })
  return made.matchId
}

describe('a carrom table', () => {
  test('the catalogue offers Carrom as playable; a table of 6 is refused (4 at most)', async () => {
    const cat = await call(G.gameCatalog, 'A', {})
    expect(cat.games.find((g) => g.gameId === 'carrom').playable).toBe(true)
    const e = await refusal(call(G.createGameMatch, 'A', { gameId: 'carrom', players: 6, entry: 100, idempotencyKey: key() }))
    expect(e.code).toBe('invalid-argument')
    expect(diamonds('A')).toBe(1000)
  })
  test('a shot is simulated by the server and stored for replay; out of turn and stale taps change nothing', async () => {
    const id = await table(2)
    const m = match(id)
    expect(m.status).toBe('playing')
    expect(m.state.sides).toEqual([0, 2])
    expect(m.state.maxShots).toBe(10)
    const shooter = m.seats[m.state.turn].uid
    const other = m.seats[1 - m.state.turn].uid
    expect((await refusal(call(G.carromShot, other, { matchId: id, x: 0.5, angle: -1.57, power: 0.8 }))).message).toContain('not your turn')
    expect((await call(G.carromShot, shooter, { matchId: id, x: 0.5, angle: -1.57, power: 0.8, step: 9 })).stale).toBe(true)
    const r = await call(G.carromShot, shooter, { matchId: id, x: 0.5, angle: -Math.PI / 2, power: 1, step: m.state.step })
    expect(r.applied).toBe(true)
    const after = match(id)
    expect(after.state.step).toBe(m.state.step + 1)
    expect(after.lastShot.n).toBe(1)
    expect(after.lastShot.bodies).toBe(20)
    const frames = CR.unpackFrames(after.lastShot.frames, 20)
    expect(frames.length > 5).toBe(true)
    const last = frames[frames.length - 1]
    after.state.pieces.forEach((p, i) => {
      if (p.on) expect(Math.abs(last[2 + 2 * i] - p.x) <= 0.5 && Math.abs(last[3 + 2 * i] - p.y) <= 0.5).toBe(true)
    })
  })
  test('leaving during play: the other player wins 100 + 100 → 150, Zipper 50', async () => {
    const id = await table(2)
    const r = await call(G.leaveGameMatch, 'B', { matchId: id })
    expect(r.forfeited).toBe(true)
    const m = match(id)
    expect(m.winners).toEqual(['A'])
    expect(m.payouts).toEqual({ A: 150 })
    expect(m.fee).toBe(50)
    expect(diamonds('A')).toBe(1050)
    expect(diamonds('B')).toBe(900)
    expect(sumKind(id, 'entry') - sumKind(id, 'payout') - sumKind(id, 'fee')).toBe(0)
  })
  test('missed turns: each timeout passes the turn; the third miss in a row puts a player out', async () => {
    const id = await table(2)
    const first = match(id).state.turn
    for (let k = 0; k < 5; k++) {
      const m = match(id)
      db.seed(`gameMatches/${id}`, { ...m, deadlineMs: Date.now() - 1000 })
      const anyone = m.seats[0].uid
      const r = await call(G.claimGameTimeout, anyone, { matchId: id, step: m.state.step })
      expect(r.applied).toBe(true)
    }
    const m = match(id)
    expect(m.status).toBe('finished')
    expect(m.state.endedBy).toBe('last_player')
    expect(m.winners).toEqual([m.seats[1 - first].uid])
    expect(m.payouts[m.seats[1 - first].uid]).toBe(150)
  })
  test('a whole game of 5 shots each: settled to the top score, and the ledger balances', async () => {
    const id = await table(2)
    let guard = 0
    while (match(id).status === 'playing' && guard++ < 40) {
      const m = match(id)
      const uid = m.seats[m.state.turn].uid
      let shot = null
      for (const x of [0.5, 0.3, 0.7, 0.1, 0.9, 0.0, 1.0]) {
        try {
          shot = await call(G.carromShot, uid, { matchId: id, x, angle: -Math.PI / 2 + (guard % 5 - 2) * 0.15, power: 0.55 + (guard % 4) * 0.12, step: m.state.step })
          break
        } catch (e) {
          if (!String(e.message).includes('striker is on a piece')) throw e
        }
      }
      expect(shot !== null).toBe(true)
    }
    const m = match(id)
    expect(m.status).toBe('finished')
    const top = Math.max(...m.state.scores)
    expect(m.winners).toEqual(m.state.scores.map((sc, i) => (sc === top ? m.seats[i].uid : null)).filter(Boolean))
    expect(sumKind(id, 'entry')).toBe(200)
    expect(sumKind(id, 'entry') - sumKind(id, 'payout') - sumKind(id, 'fee')).toBe(0)
    expect(diamonds('A') + diamonds('B') + m.fee).toBe(2000)
    for (const u of ['A', 'B']) expect(['won', 'lost']).toContain(db.read(`users/${u}/gameHistory/${id}`).result)
  })
})

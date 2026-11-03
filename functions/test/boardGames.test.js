/**
 * B4 (3 Nov 2026) — Snakes & Ladders and Four in a Row: the rules (pure) and the SHIPPED callables over the
 * in-memory Firestore, optimistic transactions.
 *
 * Money as in every friendly match: entries escrowed, the winner paid the pool less the fee (100 + 100 at 25 % →
 * 150 / 50), a Four in a Row draw shares it (75 + 75, Zipper 50), leaving forfeits, Σ debits = Σ payouts + fee.
 *
 * Run:  node --test test/boardGames.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const G = require('../lib/games/matches')
const B = require('../lib/games/boardGames')
const R = require('../lib/games/rng')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let keyN = 0
const key = () => `key-${++keyN}-boardgames`

// ─────────────────────────────────────────────────────────────────────────────
describe('snakes & ladders: the board and the rules', () => {
  test('ladders go up, snakes go down, nothing chains, nothing on 0 or 100', () => {
    for (const [a, b] of Object.entries(B.LADDERS)) expect(Number(b) > Number(a)).toBe(true)
    for (const [a, b] of Object.entries(B.SNAKES)) expect(Number(b) < Number(a)).toBe(true)
    const starts = new Set([...Object.keys(B.LADDERS), ...Object.keys(B.SNAKES)].map(Number))
    expect(starts.size).toBe(Object.keys(B.LADDERS).length + Object.keys(B.SNAKES).length)
    for (const end of [...Object.values(B.LADDERS), ...Object.values(B.SNAKES)]) expect(starts.has(end)).toBe(false)
    expect(starts.has(0) || starts.has(100)).toBe(false)
  })
  test('roll and move; a ladder climbs, a snake slides; the turn passes', () => {
    let s = B.newSnakes(2, 0)
    let r = B.snakesRoll(s, 0, 3)                                // 0 + 3 = 3: a ladder to 20
    expect(r.event).toMatchObject({ from: 0, landed: 3, to: 20, via: 'ladder' })
    expect(r.state.turn).toBe(1)
    s = { ...r.state, positions: [20, 13] }
    r = B.snakesRoll(s, 1, 4)                                    // 13 + 4 = 17: a snake to 4
    expect(r.event).toMatchObject({ landed: 17, to: 4, via: 'snake' })
  })
  test('100 exactly: a roll past it stays; landing on it wins', () => {
    const s = { ...B.newSnakes(2, 0), positions: [98, 0] }
    const over = B.snakesRoll(s, 0, 5)
    expect(over.event.stayed).toBe(true)
    expect(over.state.positions[0]).toBe(98)
    const win = B.snakesRoll(s, 0, 2)
    expect(win.state.winner).toBe(0)
    expect(() => B.snakesRoll(win.state, 1, 3)).toThrow('over')
  })
  test('out of turn and bad dice are refused', () => {
    const s = B.newSnakes(3, 1)
    expect(() => B.snakesRoll(s, 0, 3)).toThrow('not your turn')
    expect(() => B.snakesRoll(s, 1, 7)).toThrow('bad die')
  })
  test('the server rolls for an absent player; three misses in a row and they are out; the last one in wins', () => {
    let s = B.newSnakes(2, 0)
    for (let k = 0; k < 5; k++) s = B.snakesTimeout(s, 1).state
    expect(s.out).toEqual([true, false])
    expect(s.winner).toBe(1)
  })
  test('rolling yourself clears your misses; leaving in a 3-player game moves play on', () => {
    let s = B.snakesTimeout(B.newSnakes(3, 0), 1).state         // seat 0 missed
    expect(s.misses[0]).toBe(1)
    s = B.snakesRoll(s, 1, 1).state
    s = B.snakesRoll(s, 2, 1).state
    s = B.snakesRoll(s, 0, 1).state
    expect(s.misses[0]).toBe(0)
    const f = B.snakesForfeit(s, 1)
    expect(f.out).toEqual([false, true, false])
    expect(f.turn).toBe(2)
    expect(f.winner).toBe(null)
  })
})

describe('four in a row: the rules', () => {
  const play = (moves, first = 0) => moves.reduce((s, col) => B.fourRowDrop(s, s.turn, col).state, B.newFourRow(first))

  test('discs stack from the bottom; a full column is refused', () => {
    let s = play([3, 3, 3, 3, 3, 3])
    expect([0, 1, 2, 3, 4, 5].map((r) => s.cells[r * 7 + 3])).toEqual([0, 1, 0, 1, 0, 1])
    expect(() => B.fourRowDrop(s, s.turn, 3)).toThrow('full')
    expect(B.legalColumns(s)).toEqual([0, 1, 2, 4, 5, 6])
    s = B.fourRowDrop(s, s.turn, 0).state
    expect(s.cells[0]).toBe(0)
  })
  test('four across, up and on both diagonals win', () => {
    const across = play([0, 0, 1, 1, 2, 2, 3])
    expect(across.winners).toEqual([0])
    expect(across.line).toEqual([0, 1, 2, 3])
    const up = play([6, 0, 6, 1, 6, 2, 6])
    expect(up.winners).toEqual([0])
    const diag = play([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3])        // / from (0,0)
    expect(diag.winners).toEqual([0])
    expect(diag.endedBy).toBe('four')
    const anti = play([6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3])        // \\ from (0,6)
    expect(anti.winners).toEqual([0])
  })
  test('a full board with no four is a draw (both share)', () => {
    // Columns filled in a pattern that never lines up four: pairs of columns alternate the starting colour.
    const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6]
    let s = B.newFourRow(0)
    for (const col of order) {
      expect(s.winners).toBe(null)
      s = B.fourRowDrop(s, s.turn, col).state
    }
    expect(s.winners).toEqual([0, 1])
    expect(s.endedBy).toBe('draw')
  })
  test('a timeout drops for the absent player and counts a miss; the second miss in a row forfeits', () => {
    let s = B.newFourRow(0)
    const t1 = B.fourRowTimeout(s, 3)
    expect(t1.event.timedOut).toBe(true)
    expect(t1.state.misses).toEqual([1, 0])
    s = B.fourRowDrop(t1.state, 1, 0).state
    const t2 = B.fourRowTimeout(s, 3)
    expect(t2.state.winners).toEqual([1])
    expect(t2.state.endedBy).toBe('forfeit')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const ON = {
  enabled: true,
  games: {
    snakes: { enabled: true, entryOptions: [100], platformFeePct: 25, modes: [2, 3, 4], turnSeconds: 20, waitMinutes: 10 },
    four_row: { enabled: true, entryOptions: [100], platformFeePct: 25, modes: [2], turnSeconds: 30, waitMinutes: 10 },
  },
}
const diamonds = (uid) => db.read(`users/${uid}`).diamonds
const match = (id) => db.read(`gameMatches/${id}`)
const ledger = (id) => db.all('gameLedger').filter((r) => r.matchId === id)
const sum = (id, k) => ledger(id).filter((x) => x.kind === k).reduce((a, x) => a + x.diamonds, 0)
const balances = (id) => expect(sum(id, 'entry') - sum(id, 'payout') - sum(id, 'fee')).toBe(0)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  for (const u of ['A', 'B', 'C', 'D']) db.seed(`users/${u}`, { name: u, diamonds: 1000 })
})

async function table(gameId, players = 2) {
  const made = await call(G.createGameMatch, 'A', { gameId, players, entry: 100, idempotencyKey: key() })
  for (const u of ['B', 'C', 'D'].slice(0, players - 1)) await call(G.joinGameMatch, u, { matchId: made.matchId, idempotencyKey: key() })
  return made.matchId
}

describe('snakes & ladders tables', () => {
  test('the catalogue offers it; a roll is the server\'s; out of turn and stale taps do nothing', async () => {
    const cat = await call(G.gameCatalog, 'A', {})
    expect(cat.games.find((g) => g.gameId === 'snakes').playable).toBe(true)
    const id = await table('snakes')
    const m = match(id)
    expect(m.state.positions).toEqual([0, 0])
    const me = m.seats[m.state.turn].uid
    const other = m.seats[1 - m.state.turn].uid
    expect((await refusal(call(G.snakesRoll, other, { matchId: id }))).message).toContain('not your turn')
    expect((await call(G.snakesRoll, me, { matchId: id, step: 7 })).stale).toBe(true)
    const seed = db.read(`gameMatches/${id}/private/meta`).seed
    const die = R.rollDie(seed, `${id}:roll:${m.state.turnNumber}:${m.state.step}`)
    const r = await call(G.snakesRoll, me, { matchId: id, step: m.state.step })
    expect(r.event.die).toBe(die)
  })
  test('reaching 100 wins 150 of 100 + 100; Zipper 50', async () => {
    const id = await table('snakes')
    const m = match(id)
    const seed = db.read(`gameMatches/${id}/private/meta`).seed
    const die = R.rollDie(seed, `${id}:roll:${m.state.turnNumber}:${m.state.step}`)
    const positions = [0, 0]
    positions[m.state.turn] = 100 - die
    db.seed(`gameMatches/${id}`, { ...m, state: { ...m.state, positions } })
    const winner = m.seats[m.state.turn].uid
    const r = await call(G.snakesRoll, winner, { matchId: id, step: m.state.step })
    expect(r.finished).toBe(true)
    expect(match(id).payouts).toEqual({ [winner]: 150 })
    expect(match(id).fee).toBe(50)
    expect(diamonds(winner)).toBe(1050)
    balances(id)
  })
  test('leaving forfeits; a timeout is rolled by the server', async () => {
    const id = await table('snakes', 3)
    const m = match(id)
    db.seed(`gameMatches/${id}`, { ...m, deadlineMs: Date.now() - 1000 })
    const t = await call(G.claimGameTimeout, 'A', { matchId: id, step: m.state.step })
    expect(t.applied).toBe(true)
    expect(match(id).state.misses[m.state.turn]).toBe(1)
    await call(G.leaveGameMatch, 'B', { matchId: id })
    await call(G.leaveGameMatch, 'C', { matchId: id })
    const end = match(id)
    expect(end.status).toBe('finished')
    expect(end.winners).toEqual(['A'])
    expect(end.payouts).toEqual({ A: 225 })               // 300 less 25 %
    balances(id)
  })
})

describe('four in a row tables', () => {
  test('four up wins 150; Zipper 50', async () => {
    const id = await table('four_row')
    const first = match(id).state.turn
    const p = [match(id).seats[first].uid, match(id).seats[1 - first].uid]
    for (const [who, col] of [[0, 0], [1, 1], [0, 0], [1, 1], [0, 0], [1, 1]]) {
      await call(G.fourRowDrop, p[who], { matchId: id, col, step: match(id).state.step })
    }
    const r = await call(G.fourRowDrop, p[0], { matchId: id, col: 0, step: match(id).state.step })
    expect(r.finished).toBe(true)
    expect(match(id).winners).toEqual([p[0]])
    expect(match(id).payouts).toEqual({ [p[0]]: 150 })
    expect(match(id).state.line).toEqual([0, 7, 14, 21])
    balances(id)
  })
  test('a draw shares the pool: 75 + 75, Zipper 50', async () => {
    const id = await table('four_row')
    const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6]
    for (const col of order) {
      const m = match(id)
      await call(G.fourRowDrop, m.seats[m.state.turn].uid, { matchId: id, col, step: m.state.step })
    }
    const m = match(id)
    expect(m.state.endedBy).toBe('draw')
    expect(m.payouts).toEqual({ A: 75, B: 75 })
    expect(m.fee).toBe(50)
    expect(diamonds('A') + diamonds('B')).toBe(2000 - 50)
    balances(id)
  })
  test('a full column and a stranger are refused; two missed turns in a row forfeit', async () => {
    const id = await table('four_row')
    expect((await refusal(call(G.fourRowDrop, 'C', { matchId: id, col: 0 }))).code).toBe('permission-denied')
    const absent = match(id).seats[match(id).state.turn].uid
    for (let k = 0; k < 2; k++) {
      const m = match(id)
      db.seed(`gameMatches/${id}`, { ...m, deadlineMs: Date.now() - 1000 })
      await call(G.claimGameTimeout, m.seats[0].uid, { matchId: id, step: m.state.step })
      // The other player plays in between, so the absent player's misses are "in a row".
      const after = match(id)
      if (after.status === 'playing' && after.seats[after.state.turn].uid !== absent) {
        await call(G.fourRowDrop, after.seats[after.state.turn].uid, { matchId: id, col: 6, step: after.state.step })
      }
    }
    const end = match(id)
    expect(end.status).toBe('finished')
    expect(end.state.endedBy).toBe('forfeit')
    expect(end.winners.includes(absent)).toBe(false)
    balances(id)
  })
})

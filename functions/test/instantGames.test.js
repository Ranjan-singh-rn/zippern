/**
 * B5 (3 Nov 2026) — instant games: the maths can never pay more than the configured return, and the shipped
 * callables move diamonds exactly once per round.
 *
 *   * RTP: every Peg Drop table (8/12/16 rows × low/medium/high), the Mela Reels paytable and the Lucky Catch table
 *     return at most 1 − house edge (computed exactly), and not absurdly less; Zip Flight's crash points follow
 *     P(c ≥ x) = (1 − edge)/x (simulated); Lane Hopper's ladder returns 1 − edge at every lane.
 *   * Money: stake debited, win credited, ledger rows (stake / win) on the player's history and in `gameLedger`;
 *     a replayed request is answered from the first, nothing moves twice; not enough diamonds refuses before a draw.
 *   * Lane Hopper: survive a lane, lose on the server's hidden lane, cash out once; a repeated tap for the same lane
 *     does nothing.
 *   * Zip Flight: nothing during the countdown; a cash-out before the crash pays ⌊entry × multiplier⌋; after it,
 *     nothing; the auto cash-out pays if the flight reached it; the crash point is revealed only at the end.
 *   * Fairness: the commitment shown before play is the SHA-256 of the seed revealed by rotation.
 *
 * Run:  node --test test/instantGames.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const I = require('../lib/games/instant')
const M = require('../lib/games/instantMath')
const R = require('../lib/games/rng')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let n = 0
const key = () => `k${++n}-instant-xx`

const ON = {
  enabled: true,
  games: {
    plinko: { enabled: true, entryOptions: [], minEntry: 10, maxEntry: 5000, rows: [8, 12, 16], houseEdgePct: 3 },
    slots: { enabled: true, entryOptions: [10, 50, 100], houseEdgePct: 4 },
    fishing: { enabled: true, entryOptions: [10, 50, 100], houseEdgePct: 4 },
    chicken_road: { enabled: true, entryOptions: [], minEntry: 10, maxEntry: 5000, houseEdgePct: 3, lanes: 20 },
    crash: { enabled: true, entryOptions: [], minEntry: 10, maxEntry: 10000, houseEdgePct: 3, maxMultiplier: 1000 },
  },
}
const diamonds = () => db.read('users/P').diamonds
const rows = (roundId) => db.all('gameLedger').filter((r) => r.roundId === roundId)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  db.seed('users/P', { name: 'P', diamonds: 10_000 })
})

describe('the maths never returns more than 1 − edge', () => {
  test('every Peg Drop table', () => {
    for (const rows of [8, 12, 16]) {
      for (const risk of ['low', 'medium', 'high']) {
        const t = M.plinkoTable(rows, risk, 0.97)
        const rtp = M.plinkoRtp(rows, t)
        expect(rtp <= 0.97 + 1e-9).toBe(true)
        expect(rtp > 0.95).toBe(true)
        expect(t.length).toBe(rows + 1)
        expect(t[0]).toBe(t[rows])                                   // symmetric
      }
    }
    // Riskier tables have bigger edges and smaller middles.
    expect(M.plinkoTable(16, 'high', 0.97)[0] > M.plinkoTable(16, 'low', 0.97)[0]).toBe(true)
  })
  test('Mela Reels and Lucky Catch', () => {
    const pays = M.slotPaytable(0.96)
    const rtp = M.slotRtp(pays)
    expect(rtp <= 0.96 + 1e-9 && rtp > 0.93).toBe(true)
    const c = M.catchTable(0.96)
    const crtp = M.catchRtp(c)
    expect(crtp <= 0.96 + 1e-9 && crtp > 0.94).toBe(true)
  })
  test('Zip Flight: P(crash ≥ 2) ≈ 0.485 over 100 000 draws, nothing below 1, nothing above the cap', () => {
    const seed = R.newSeed()
    let atLeast2 = 0
    for (let i = 0; i < 100_000; i++) {
      const c = M.crashPoint(seed, `c:${i}`, 3, 1000)
      expect(c >= 1 && c <= 1000).toBe(true)
      if (c >= 2) atLeast2++
    }
    expect(Math.abs(atLeast2 / 100_000 - 0.485) < 0.01).toBe(true)
    expect(M.crashMultiplierAt(0)).toBe(1)
    expect(M.crashMultiplierAt(10_000)).toBe(2)
    expect(M.crashFlightMs(2) >= 10_000 && M.crashFlightMs(2) < 10_010).toBe(true)
  })
  test('Lane Hopper: the ladder returns 1 − edge at every lane', () => {
    const p = M.CHICKEN_DIFFICULTY.medium
    for (let k = 1; k <= 20; k++) {
      const m = M.chickenMultiplier(k, p, 3)
      expect(Math.pow(1 - p, k) * m <= 0.97 + 1e-9).toBe(true)
    }
  })
  test('a slot spin pays what its lines say', () => {
    const pays = M.slotPaytable(0.96)
    const seed = R.newSeed()
    for (let i = 0; i < 2000; i++) {
      const s = M.slotSpin(seed, `s:${i}`, pays)
      expect(s.grid.length).toBe(5)
      const sum = Math.floor(s.wins.reduce((a, w) => a + w.multiplier, 0) * 100 + 1e-9) / 100
      expect(s.multiplier).toBe(sum)
    }
  })
})

describe('one-call games move diamonds once', () => {
  test('Peg Drop: stake, drop, win — and the ledger agrees', async () => {
    const r = await call(I.playPlinko, 'P', { entry: 100, rows: 12, risk: 'high', idempotencyKey: key() })
    expect(r.status).toBe('settled')
    expect(r.outcome.path.length).toBe(12)
    expect(r.payout).toBe(Math.floor(100 * r.multiplier + 1e-9))
    expect(diamonds()).toBe(10_000 - 100 + r.payout)
    const ledger = rows(r.roundId)
    expect(ledger.find((x) => x.kind === 'stake').diamonds).toBe(100)
    expect((ledger.find((x) => x.kind === 'win') || { diamonds: 0 }).diamonds).toBe(r.payout)
    expect(db.read(`users/P/gameHistory/${r.roundId}`).payout).toBe(r.payout)
  })
  test('the same request twice: one round, one stake', async () => {
    const k = key()
    const a = await call(I.spinSlots, 'P', { entry: 50, idempotencyKey: k })
    const b = await call(I.spinSlots, 'P', { entry: 50, idempotencyKey: k })
    expect(b.roundId).toBe(a.roundId)
    expect(b.replayed).toBe(true)
    expect(diamonds()).toBe(10_000 - 50 + a.payout)
    // Stored as Firestore stores it: the grid flat, reel by reel (no array inside an array).
    expect(a.outcome.grid.length).toBe(a.outcome.reels * a.outcome.rows)
    expect(a.outcome.grid.some((x) => Array.isArray(x))).toBe(false)
  })
  test('not enough diamonds: refused before anything is drawn', async () => {
    db.seed('users/P', { name: 'P', diamonds: 5 })
    const e = await refusal(call(I.castFishing, 'P', { entry: 10, idempotencyKey: key() }))
    expect(e.details.code).toBe('INSUFFICIENT_DIAMONDS')
    expect(db.all('gameRounds').length).toBe(0)
  })
  test('a switched-off game refuses', async () => {
    db.seed('appConfig/games', { ...ON, games: { ...ON.games, slots: { ...ON.games.slots, enabled: false } } })
    const e = await refusal(call(I.spinSlots, 'P', { entry: 10, idempotencyKey: key() }))
    expect(e.details.code).toBe('GAME_DISABLED')
  })
})

describe('Lane Hopper', () => {
  async function start() {
    const r = await call(I.chickenStart, 'P', { entry: 100, difficulty: 'medium', idempotencyKey: key() })
    const deathLane = db.read(`gameRounds/${r.roundId}/private/secret`).deathLane
    return { ...r, deathLane }
  }
  test('lost on the hidden lane: nothing paid, the lane revealed', async () => {
    const r = await start()
    let last
    for (let lane = 1; lane <= Math.min(r.deathLane, 20); lane++) last = await call(I.chickenStep, 'P', { roundId: r.roundId, lane })
    if (r.deathLane <= 20) {
      expect(last.status).toBe('settled')
      expect(last.payout).toBe(0)
      expect(last.outcome.lostAt).toBe(r.deathLane)
      expect(diamonds()).toBe(9_900)
    }
  })
  test('cash out after a safe lane: paid once at that lane\'s multiplier', async () => {
    let r = await start()
    while (r.deathLane === 1) { db._docs.clear(); db.seed('appConfig/games', ON); db.seed('users/P', { name: 'P', diamonds: 10_000 }); r = await start() }
    const step = await call(I.chickenStep, 'P', { roundId: r.roundId, lane: 1 })
    expect(step.status).toBe('open')
    const again = await call(I.chickenStep, 'P', { roundId: r.roundId, lane: 1 })
    expect(again.stale).toBe(true)                                     // a repeated tap does nothing
    const out = await call(I.chickenCashout, 'P', { roundId: r.roundId })
    expect(out.payout).toBe(Math.floor(100 * r.outcome.ladder[0] + 1e-9))
    const twice = await call(I.chickenCashout, 'P', { roundId: r.roundId })
    expect(twice.already).toBe(true)
    expect(diamonds()).toBe(9_900 + out.payout)
  })
  test('cashing out before crossing any lane is refused, not paid', async () => {
    const r = await start()
    const out = await call(I.chickenCashout, 'P', { roundId: r.roundId })
    expect(out.status).toBe('open')
    expect(diamonds()).toBe(9_900)
  })
  test('another player cannot touch the round', async () => {
    db.seed('users/Q', { name: 'Q', diamonds: 100 })
    const r = await start()
    expect((await refusal(call(I.chickenStep, 'Q', { roundId: r.roundId }))).code).toBe('permission-denied')
  })
})

describe('Zip Flight', () => {
  async function flying(msIntoFlight, crashAt, autoCashout = 0) {
    const r = await call(I.crashStart, 'P', { entry: 100, autoCashout, idempotencyKey: key() })
    const round = db.read(`gameRounds/${r.roundId}`)
    db.seed(`gameRounds/${r.roundId}`, { ...round, outcome: { ...round.outcome, startsAtMs: Date.now() - msIntoFlight } })
    db.seed(`gameRounds/${r.roundId}/private/secret`, { crashAt, crashesAtMs: 0 })
    return r.roundId
  }
  test('the countdown: nothing settles, the crash point is not revealed', async () => {
    const r = await call(I.crashStart, 'P', { entry: 100, idempotencyKey: key() })
    expect(r.outcome.crashAt).toBe(undefined)
    const p = await call(I.crashPoll, 'P', { roundId: r.roundId })
    expect(p.status).toBe('open')
    expect(p.phase).toBe('countdown')
  })
  test('cash out at ×2 before a ×5 crash: 200 paid, once', async () => {
    const id = await flying(10_000, 5)
    const c = await call(I.crashCashout, 'P', { roundId: id })
    expect(c.multiplier).toBe(2)
    expect(c.payout).toBe(200)
    expect(c.outcome.crashAt).toBe(5)                                  // revealed at the end
    const again = await call(I.crashCashout, 'P', { roundId: id })
    expect(again.already).toBe(true)
    expect(diamonds()).toBe(9_900 + 200)
  })
  test('too late: the flight crashed at ×1.5 before the cash-out', async () => {
    const id = await flying(10_000, 1.5)
    const c = await call(I.crashCashout, 'P', { roundId: id })
    expect(c.payout).toBe(0)
    expect(c.outcome.crashed).toBe(true)
    expect(diamonds()).toBe(9_900)
  })
  test('auto cash-out at ×1.5 reached before a ×3 crash pays 150 on the next poll', async () => {
    const id = await flying(30_000, 3, 1.5)
    const p = await call(I.crashPoll, 'P', { roundId: id })
    expect(p.payout).toBe(150)
    expect(p.outcome.auto).toBe(true)
  })
  test('still flying: the poll says where it is and settles nothing', async () => {
    const id = await flying(5_000, 50)
    const p = await call(I.crashPoll, 'P', { roundId: id })
    expect(p.phase).toBe('flying')
    expect(p.multiplier >= 1.41 && p.multiplier <= 1.42).toBe(true)
    expect(diamonds()).toBe(9_900)
  })
})

describe('provably fair', () => {
  test('the commitment shown before play is the hash of the seed revealed after', async () => {
    const before = await call(I.gameFairness, 'P', {})
    const r = await call(I.playPlinko, 'P', { entry: 10, rows: 8, risk: 'low', idempotencyKey: key() })
    expect(r.fairness.commit).toBe(before.commit)
    expect(r.fairness.nonce).toBe(0)
    const rot = await call(I.rotateGameSeed, 'P', { clientSeed: 'my-seed' })
    expect(R.commitOf(rot.revealed.seed)).toBe(before.commit)
    expect(rot.revealed.rounds).toBe(1)
    // The revealed seed recomputes the round: same path.
    const path = M.plinkoDrop(rot.revealed.seed, `plinko::0`, 8).path
    expect(path).toEqual(r.outcome.path)
    expect(rot.next.clientSeed).toBe('my-seed')
  })
})

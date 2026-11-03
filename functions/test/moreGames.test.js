/**
 * B5 (3 Nov 2026) — the second set of quick games: Lucky Dice, Toss Up, Fortune Wheel, Number Draw (keno), Sky High
 * (limbo), Roulette, Dragon Tiger, Andar Bahar, Higher or Lower, Gem Field (mines).
 *
 *   * Odds: every table returns at most 1 − the Owner's house edge (computed exactly where it can be, simulated
 *     where it cannot), and the familiar tables come out at their familiar edges (roulette's zero 2.70 %: 36× / 3× /
 *     2×; Dragon Tiger at 2.94 %: 2× with half back on a tie).
 *   * Money: the SHIPPED callables over the in-memory Firestore — stake debited, win credited, ledger rows, history;
 *     a bad choice refused before anything moves; the Owner's edge (even 0 %) is the one applied.
 *   * Multi-step rounds: the hidden part (next cards, mine positions) never leaves the server until the round ends;
 *     a repeated tap does nothing twice; a round settles exactly once.
 *
 * Run:  node --test test/moreGames.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const I = require('../lib/games/instant')
const X = require('../lib/games/moreMath')
const R = require('../lib/games/rng')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let n = 0
const key = () => `k${++n}-more-games-xx`

const IDS = ['dice', 'coin_toss', 'wheel', 'keno', 'limbo', 'roulette', 'dragon_tiger', 'andar_bahar', 'hilo', 'mines']
const EDGE = { roulette: 2.7, dragon_tiger: 2.94 }
const ON = {
  enabled: true,
  games: Object.fromEntries(IDS.map((id) => [id, { enabled: true, entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: EDGE[id] ?? 3 }])),
}
const diamonds = () => db.read('users/P').diamonds
const rows = (roundId) => db.all('gameLedger').filter((r) => r.roundId === roundId)

beforeEach(() => {
  db._docs.clear()
  db.seed('appConfig/games', ON)
  db.seed('users/P', { name: 'P', diamonds: 10_000 })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the odds never return more than 1 − edge', () => {
  test('dice: the chance is exact and the multiplier is (100 − edge) / chance, rounded down', () => {
    for (const chance of [2, 10, 33, 49.5, 50, 75, 95].filter(Number.isInteger)) {
      let under = 0
      let over = 0
      for (let roll = 0; roll < 10_000; roll++) {
        if (X.diceWins(roll, chance, 'under')) under++
        if (X.diceWins(roll, chance, 'over')) over++
      }
      expect(under).toBe(chance * 100)
      expect(over).toBe(chance * 100)
      const m = X.diceMultiplier(chance, 3)
      expect((m * chance) / 100 <= 0.97 + 1e-9).toBe(true)
      expect((m * chance) / 100 > 0.96).toBe(true)
    }
    expect(X.diceMultiplier(50, 3)).toBe(1.94)
    expect(X.diceMultiplier(2, 3)).toBe(48.5)
    expect(X.coinMultiplier(3)).toBe(1.94)
  })

  test('wheel: 20 segments a risk, each returning between 96 % and 97 %', () => {
    for (const risk of X.WHEEL_RISKS) {
      const t = X.wheelTable(risk, 3)
      expect(t.length).toBe(20)
      const rtp = t.reduce((a, b) => a + b, 0) / 20
      expect(rtp <= 0.97 + 1e-9 && rtp > 0.96).toBe(true)
    }
  })

  test('keno: hit chances add to 1; every paytable returns 96–97 %; ten different numbers are drawn', () => {
    for (let picks = 1; picks <= 10; picks++) {
      let total = 0
      for (let h = 0; h <= picks; h++) total += X.kenoHitChance(picks, h)
      expect(Math.abs(total - 1) < 1e-12).toBe(true)
      const t = X.kenoTable(picks, 3)
      const rtp = t.reduce((a, m, h) => a + m * X.kenoHitChance(picks, h), 0)
      expect(rtp <= 0.97 + 1e-9 && rtp > 0.96).toBe(true)
    }
    const d = X.kenoDraw(R.newSeed(), 'k')
    expect(d.length).toBe(10)
    expect(new Set(d).size).toBe(10)
    expect(d.every((x) => x >= 1 && x <= 40)).toBe(true)
  })

  test('limbo: P(result ≥ target) = (1 − edge) / target (60 000 draws)', () => {
    const seed = R.newSeed()
    const N = 60_000
    for (const target of [2, 5]) {
      let hit = 0
      for (let i = 0; i < N; i++) if (X.limboResult(seed, `l:${target}:${i}`, 3) >= target) hit++
      const want = 0.97 / target
      expect(Math.abs(hit / N - want) < 4 * Math.sqrt((want * (1 - want)) / N)).toBe(true)
    }
    for (let i = 0; i < 1000; i++) {
      const r = X.limboResult(seed, `r${i}`, 3)
      expect(r >= 1 && r <= X.LIMBO_MAX).toBe(true)
    }
  })

  test('roulette: at the zero\'s own 2.70 % the familiar 36× / 3× / 2×; every bet returns 36/37 or less', () => {
    expect(X.rouletteMultiplier('straight', 2.7)).toBe(36)
    expect(X.rouletteMultiplier('dozen', 2.7)).toBe(3)
    expect(X.rouletteMultiplier('red', 2.7)).toBe(2)
    for (const bet of X.ROULETTE_BETS) {
      expect((X.rouletteMultiplier(bet, 2.7) * X.rouletteCovers(bet)) / 37 <= 36 / 37 + 1e-9).toBe(true)
    }
    expect(X.rouletteWins(0, 'red', 0)).toBe(false)
    expect(X.rouletteWins(0, 'even', 0)).toBe(false)
    expect(X.rouletteWins(0, 'straight', 0)).toBe(true)
    expect(X.rouletteWins(1, 'red', 0)).toBe(true)
    expect(X.rouletteWins(2, 'black', 0)).toBe(true)
    expect(X.rouletteWins(13, 'dozen', 2)).toBe(true)
    expect(X.rouletteWins(34, 'column', 1)).toBe(true)
    expect(X.rouletteWins(36, 'column', 3)).toBe(true)
    expect(X.rouletteWins(19, 'high', 0)).toBe(true)
    expect(X.RED.size).toBe(18)
  })

  test('dragon tiger: ace low, king high; at 2.94 % a side pays 2× and half back on a tie', () => {
    expect(X.dtValue(12)).toBe(0)        // A
    expect(X.dtValue(11)).toBe(12)       // K
    expect(X.dtValue(0)).toBe(1)         // 2
    const p = X.dragonTigerMultipliers(2.94)
    expect(p).toEqual({ side: 2, tie: 16.5, tieRefund: 0.5 })
    const side = p.side * (24 / 51) + 0.5 * (3 / 51)
    expect(side <= 1 - 0.0294 + 1e-9).toBe(true)
    expect(p.tie * (3 / 51) <= 1 - 0.0294 + 1e-9).toBe(true)
  })

  test('andar bahar: Andar (dealt first) is 10725 / 20825; the deal stops at the first card of the joker\'s rank', () => {
    expect(X.ANDAR_CHANCE).toBe(10725 / 20825)
    const p = X.andarBaharMultipliers(3)
    expect(p.andar * X.ANDAR_CHANCE <= 0.97 + 1e-9).toBe(true)
    expect(p.bahar * (1 - X.ANDAR_CHANCE) <= 0.97 + 1e-9).toBe(true)
    const seed = R.newSeed()
    for (let i = 0; i < 300; i++) {
      const d = X.andarBaharDeal(seed, `ab${i}`)
      const last = d.dealt[d.dealt.length - 1]
      expect(last % 13).toBe(d.joker % 13)
      expect(d.dealt.slice(0, -1).every((c) => c % 13 !== d.joker % 13)).toBe(true)
      expect(d.winner).toBe(d.dealt.length % 2 === 1 ? 'andar' : 'bahar')
    }
  })

  test('higher or lower: "higher" includes the same rank; each correct guess pays (1 − edge) / chance', () => {
    expect(X.hiloChance(12, 'higher')).toBe(1 / 13)       // an ace: only another ace
    expect(X.hiloChance(12, 'lower')).toBe(1)
    expect(X.hiloChance(0, 'higher')).toBe(1)
    expect(X.hiloCorrect(5, 18, 'higher')).toBe(true)      // the same rank in another suit
    expect(X.hiloCorrect(5, 4, 'higher')).toBe(false)
    expect(X.hiloCorrect(5, 4, 'lower')).toBe(true)
    expect(Math.abs(X.hiloFactor(6, 'higher', 3) * X.hiloChance(6, 'higher') - 0.97) < 1e-12).toBe(true)
    expect(X.hiloCards(R.newSeed(), 'h').length).toBe(X.HILO_DECK)
  })

  test('gem field: (1 − edge) × C(25, k) / C(25 − mines, k); the layout is distinct tiles', () => {
    expect(X.minesMultiplier(3, 0, 3)).toBe(1)
    expect(X.minesMultiplier(1, 1, 3)).toBe(X.floor2(0.97 * 25 / 24))
    expect(X.minesMultiplier(24, 1, 3)).toBe(24.25)
    // Every step returns (1 − edge) before rounding: P(safe k) × multiplier.
    for (const mines of [1, 3, 10, 24]) {
      let pSafe = 1
      for (let k = 1; k <= 25 - mines; k++) {
        pSafe *= (25 - mines - (k - 1)) / (25 - (k - 1))
        expect(pSafe * X.minesMultiplier(mines, k, 3) <= 0.97 + 1e-9).toBe(true)
      }
    }
    const l = X.minesLayout(R.newSeed(), 'm', 5)
    expect(new Set(l).size).toBe(5)
    expect(l.every((t) => t >= 0 && t < 25)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
async function settledOnce(r, entry) {
  expect(r.status).toBe('settled')
  expect(r.payout).toBe(Math.floor(entry * r.multiplier + 1e-9))
  expect(diamonds()).toBe(10_000 - entry + r.payout)
  const led = rows(r.roundId)
  expect(led.find((x) => x.kind === 'stake').diamonds).toBe(entry)
  expect((led.find((x) => x.kind === 'win') || { diamonds: 0 }).diamonds).toBe(r.payout)
  expect(db.read(`users/P/gameHistory/${r.roundId}`).payout).toBe(r.payout)
}

describe('one-call games move diamonds once', () => {
  test('dice', async () => {
    const r = await call(I.playDice, 'P', { entry: 100, chance: 50, direction: 'under', idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.outcome.won).toBe(r.outcome.roll < 50)
    expect(r.multiplier).toBe(r.outcome.won ? 1.94 : 0)
  })
  test('toss up', async () => {
    const r = await call(I.tossCoin, 'P', { entry: 50, side: 'heads', idempotencyKey: key() })
    await settledOnce(r, 50)
    expect(r.multiplier).toBe(r.outcome.landed === 'heads' ? 1.94 : 0)
  })
  test('fortune wheel', async () => {
    const r = await call(I.spinWheel, 'P', { entry: 100, risk: 'high', idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.multiplier).toBe(r.outcome.table[r.outcome.segment])
  })
  test('number draw', async () => {
    const r = await call(I.playKeno, 'P', { entry: 100, picks: [5, 1, 40, 22], idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.outcome.picks).toEqual([1, 5, 22, 40])
    expect(r.outcome.hits).toEqual(r.outcome.picks.filter((p) => r.outcome.drawn.includes(p)))
    expect(r.multiplier).toBe(r.outcome.table[r.outcome.hits.length])
  })
  test('sky high', async () => {
    const r = await call(I.playLimbo, 'P', { entry: 100, target: 2, idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.multiplier).toBe(r.outcome.result >= 2 ? 2 : 0)
  })
  test('roulette', async () => {
    const r = await call(I.spinRoulette, 'P', { entry: 100, bet: 'red', idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.multiplier).toBe(X.RED.has(r.outcome.pocket) ? 2 : 0)
  })
  test('dragon tiger', async () => {
    const r = await call(I.playDragonTiger, 'P', { entry: 100, side: 'dragon', idempotencyKey: key() })
    await settledOnce(r, 100)
    const want = r.outcome.winner === 'dragon' ? 2 : r.outcome.winner === 'tie' ? 0.5 : 0
    expect(r.multiplier).toBe(want)
  })
  test('andar bahar', async () => {
    const r = await call(I.playAndarBahar, 'P', { entry: 100, side: 'bahar', idempotencyKey: key() })
    await settledOnce(r, 100)
    expect(r.multiplier).toBe(r.outcome.winner === 'bahar' ? X.andarBaharMultipliers(3).bahar : 0)
  })
  test('bad choices are refused and nothing moves', async () => {
    const bad = [
      [I.playDice, { chance: 99, direction: 'under' }], [I.playDice, { chance: 1 }], [I.tossCoin, { side: 'edge' }],
      [I.playKeno, { picks: [] }], [I.playKeno, { picks: [1, 1, 2] }], [I.playKeno, { picks: [41] }],
      [I.playKeno, { picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }], [I.playLimbo, { target: 1 }],
      [I.playLimbo, { target: 5000 }], [I.spinRoulette, { bet: 'green' }], [I.spinRoulette, { bet: 'straight', pick: 37 }],
      [I.spinRoulette, { bet: 'dozen', pick: 4 }], [I.playDragonTiger, { side: 'lion' }], [I.playAndarBahar, { side: '' }],
      [I.minesStart, { mines: 0 }], [I.minesStart, { mines: 25 }],
    ]
    for (const [fn, extra] of bad) {
      const e = await refusal(call(fn, 'P', { entry: 100, idempotencyKey: key(), ...extra }))
      expect(e && e.code).toBe('invalid-argument')
    }
    expect(diamonds()).toBe(10_000)
    expect(db.all('gameRounds').length).toBe(0)
  })
  test('the same request twice: one round, one stake', async () => {
    const k = key()
    const a = await call(I.playDice, 'P', { entry: 100, chance: 50, direction: 'over', idempotencyKey: k })
    const b = await call(I.playDice, 'P', { entry: 100, chance: 50, direction: 'over', idempotencyKey: k })
    expect(b.roundId).toBe(a.roundId)
    expect(b.replayed).toBe(true)
    expect(diamonds()).toBe(10_000 - 100 + a.payout)
  })
  test('the Owner\'s edge is the one applied — 0 % included', async () => {
    db.seed('appConfig/games', { ...ON, games: { ...ON.games, dice: { ...ON.games.dice, houseEdgePct: 0 } } })
    const r = await call(I.playDice, 'P', { entry: 100, chance: 50, direction: 'under', idempotencyKey: key() })
    expect(r.outcome.pays).toBe(2)
    db.seed('appConfig/games', { ...ON, games: { ...ON.games, dice: { ...ON.games.dice, houseEdgePct: 1 } } })
    const r2 = await call(I.playDice, 'P', { entry: 100, chance: 2, direction: 'under', idempotencyKey: key() })
    expect(r2.outcome.pays).toBe(49.5)
  })
  test('switched off: refused', async () => {
    db.seed('appConfig/games', { ...ON, games: { ...ON.games, roulette: { ...ON.games.roulette, enabled: false } } })
    const e = await refusal(call(I.spinRoulette, 'P', { entry: 100, bet: 'red', idempotencyKey: key() }))
    expect(e.details.code).toBe('GAME_DISABLED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('higher or lower', () => {
  const secret = (id) => db.read(`gameRounds/${id}/private/secret`).cards
  /** The guess that wins for the next card (never a sure thing), or null when only a sure thing would. */
  function winningGuess(cur, next) {
    for (const g of ['higher', 'lower']) if (X.hiloChance(cur, g) < 1 && X.hiloCorrect(cur, next, g)) return g
    return null
  }

  test('the next cards stay on the server; a correct guess raises the multiplier; cash out pays it once', async () => {
    const s = await call(I.hiloStart, 'P', { entry: 100, idempotencyKey: key() })
    expect(s.status).toBe('open')
    expect(JSON.stringify(s.outcome).includes('cards')).toBe(false)
    expect(diamonds()).toBe(9900)
    expect((await refusal(call(I.hiloCashout, 'P', { roundId: s.roundId }))).message).toContain('Guess at least once')
    let o = s.outcome
    let guessed = 0
    for (let k = 0; k < 40 && guessed < 2; k++) {
      const cards = secret(s.roundId)
      const g = winningGuess(o.current, cards[o.index + 1])
      const r = await call(I.hiloGuess, 'P', { roundId: s.roundId, guess: g ?? 'skip', step: o.index })
      expect(r.status).toBe('open')
      if (g) guessed++
      o = r.outcome
    }
    expect(o.guesses).toBe(2)
    expect(o.multiplier > 1).toBe(true)
    const stale = await call(I.hiloGuess, 'P', { roundId: s.roundId, guess: 'higher', step: o.index - 1 })
    expect(stale.stale).toBe(true)
    const c = await call(I.hiloCashout, 'P', { roundId: s.roundId })
    expect(c.status).toBe('settled')
    expect(c.payout).toBe(Math.floor(100 * o.multiplier + 1e-9))
    expect(diamonds()).toBe(9900 + c.payout)
    const again = await call(I.hiloCashout, 'P', { roundId: s.roundId })
    expect(again.already).toBe(true)
    expect(diamonds()).toBe(9900 + c.payout)
  })

  test('a wrong guess ends the round with nothing; a guess that cannot lose is refused', async () => {
    const s = await call(I.hiloStart, 'P', { entry: 100, idempotencyKey: key() })
    let o = s.outcome
    for (let k = 0; k < 55; k++) {
      const cards = secret(s.roundId)
      const next = cards[o.index + 1]
      const sure = X.hiloChance(o.current, 'higher') >= 1 ? 'higher' : X.hiloChance(o.current, 'lower') >= 1 ? 'lower' : null
      if (sure) {
        const e = await refusal(call(I.hiloGuess, 'P', { roundId: s.roundId, guess: sure, step: o.index }))
        expect(e.code).toBe('failed-precondition')
      }
      const losing = ['higher', 'lower'].find((g) => X.hiloChance(o.current, g) < 1 && !X.hiloCorrect(o.current, next, g))
      if (losing) {
        const r = await call(I.hiloGuess, 'P', { roundId: s.roundId, guess: losing, step: o.index })
        expect(r.status).toBe('settled')
        expect(r.payout).toBe(0)
        expect(diamonds()).toBe(9900)
        return
      }
      o = (await call(I.hiloGuess, 'P', { roundId: s.roundId, guess: 'skip', step: o.index })).outcome
    }
    throw new Error('no losing guess found in 55 cards')
  })
})

describe('gem field', () => {
  const mines = (id) => db.read(`gameRounds/${id}/private/secret`).minePositions

  test('mine positions stay on the server; gems raise the multiplier; a repeated tile does nothing; cash out once', async () => {
    const s = await call(I.minesStart, 'P', { entry: 100, mines: 3, idempotencyKey: key() })
    expect(JSON.stringify(s.outcome).includes('minePositions')).toBe(false)
    expect((await refusal(call(I.minesCashout, 'P', { roundId: s.roundId }))).message).toContain('at least one gem')
    const safe = [...Array(25).keys()].filter((t) => !mines(s.roundId).includes(t))
    const r1 = await call(I.minesReveal, 'P', { roundId: s.roundId, tile: safe[0] })
    expect(r1.status).toBe('open')
    expect(r1.outcome.multiplier).toBe(X.minesMultiplier(3, 1, 3))
    const again = await call(I.minesReveal, 'P', { roundId: s.roundId, tile: safe[0] })
    expect(again.stale).toBe(true)
    const r2 = await call(I.minesReveal, 'P', { roundId: s.roundId, tile: safe[1] })
    expect(r2.outcome.revealed).toEqual([safe[0], safe[1]])
    const c = await call(I.minesCashout, 'P', { roundId: s.roundId })
    expect(c.status).toBe('settled')
    expect(c.payout).toBe(Math.floor(100 * X.minesMultiplier(3, 2, 3) + 1e-9))
    expect(c.outcome.minePositions).toEqual(mines(s.roundId))
    expect(diamonds()).toBe(9900 + c.payout)
    expect((await call(I.minesCashout, 'P', { roundId: s.roundId })).already).toBe(true)
  })

  test('a mine ends the round with nothing and shows where they were', async () => {
    const s = await call(I.minesStart, 'P', { entry: 100, mines: 5, idempotencyKey: key() })
    const r = await call(I.minesReveal, 'P', { roundId: s.roundId, tile: mines(s.roundId)[0] })
    expect(r.status).toBe('settled')
    expect(r.payout).toBe(0)
    expect(r.outcome.hit).toBe(mines(s.roundId)[0])
    expect(r.outcome.minePositions.length).toBe(5)
    expect(diamonds()).toBe(9900)
  })

  test('finding every gem settles at the top multiplier', async () => {
    const s = await call(I.minesStart, 'P', { entry: 10, mines: 24, idempotencyKey: key() })
    const gem = [...Array(25).keys()].find((t) => !mines(s.roundId).includes(t))
    const r = await call(I.minesReveal, 'P', { roundId: s.roundId, tile: gem })
    expect(r.status).toBe('settled')
    expect(r.outcome.cleared).toBe(true)
    expect(r.payout).toBe(Math.floor(10 * 24.25 + 1e-9))
  })

  test('somebody else\'s round is not yours', async () => {
    db.seed('users/Q', { name: 'Q', diamonds: 1000 })
    const s = await call(I.minesStart, 'P', { entry: 100, mines: 3, idempotencyKey: key() })
    expect((await refusal(call(I.minesReveal, 'Q', { roundId: s.roundId, tile: 0 }))).code).toBe('permission-denied')
  })
})

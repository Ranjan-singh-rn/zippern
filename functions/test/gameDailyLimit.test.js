/**
 * B6 (4 Nov 2026) — the Owner's daily loss limit (`appConfig/games.limits.dailyLossLimit`), which the config carried
 * and nothing enforced. Now: a new stake or match entry is refused (nothing moved) when today's net game loss (IST
 * day; staked − won, refunds counting as won) plus the new amount would pass the limit. 0 = no limit.
 *
 * Run:  node --test test/gameDailyLimit.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const I = require('../lib/games/instant')
const L = require('../lib/games/ledger')
const MT = require('../lib/games/matches')

const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const call = (fn, uid, data) => fn.run(data, { auth: { uid, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
let n = 0
const key = () => `k${++n}-limit-xx`

const cfg = (limit) => ({
  enabled: true,
  limits: { maxEntryPerRound: 100_000, dailyLossLimit: limit },
  games: {
    coin_toss: { enabled: true, entryOptions: [], minEntry: 10, maxEntry: 10_000, houseEdgePct: 3 },
    ludo: { enabled: true, modes: [2, 4], entryOptions: [100], platformFeePct: 25 },
  },
})

beforeEach(() => {
  db._docs.clear()
  db.seed('users/P', { name: 'P', diamonds: 10_000 })
})

describe('pure', () => {
  const today = L.istDayKey(Date.now())
  test('the IST day turns at 18:30 UTC', () => {
    expect(L.istDayKey(Date.UTC(2026, 10, 3, 18, 29))).toBe('2026-11-03')
    expect(L.istDayKey(Date.UTC(2026, 10, 3, 18, 30))).toBe('2026-11-04')
  })
  test('net loss is today\'s only, never negative; 0 means no limit', () => {
    expect(L.dailyLossRoom({ limit: 500, today, dayKey: today, staked: 400, won: 100 }, 200)).toEqual({ netLoss: 300, allowed: true })
    expect(L.dailyLossRoom({ limit: 500, today, dayKey: today, staked: 400, won: 100 }, 201)).toEqual({ netLoss: 300, allowed: false })
    expect(L.dailyLossRoom({ limit: 500, today, dayKey: '2026-01-01', staked: 9999, won: 0 }, 500)).toEqual({ netLoss: 0, allowed: true })
    expect(L.dailyLossRoom({ limit: 500, today, dayKey: today, staked: 100, won: 900 }, 500).netLoss).toBe(0)
    expect(L.dailyLossRoom({ limit: 0, today, dayKey: today, staked: 99999, won: 0 }, 99999).allowed).toBe(true)
  })
})

describe('instant stakes', () => {
  test('refused once the day\'s net loss would pass the limit — nothing moved', async () => {
    db.seed('appConfig/games', cfg(300))
    const today = L.istDayKey(Date.now())
    db.seed('users/P', { name: 'P', diamonds: 10_000, gameDayKey: today, gameDayStaked: 500, gameDayWon: 300 })
    const e = await refusal(call(I.tossCoin, 'P', { entry: 101, side: 'heads', idempotencyKey: key() }))
    expect(e && e.details && e.details.code).toBe(L.DAILY_LOSS_LIMIT)
    expect(db.read('users/P').diamonds).toBe(10_000)
    // 100 more fits exactly.
    await call(I.tossCoin, 'P', { entry: 100, side: 'heads', idempotencyKey: key() })
    expect(db.read('users/P').gameDayStaked).toBe(600)
  })

  test('a new day starts from zero', async () => {
    db.seed('appConfig/games', cfg(300))
    db.seed('users/P', { name: 'P', diamonds: 10_000, gameDayKey: '2026-01-01', gameDayStaked: 99_999, gameDayWon: 0 })
    await call(I.tossCoin, 'P', { entry: 300, side: 'tails', idempotencyKey: key() })
    const u = db.read('users/P')
    expect(u.gameDayKey).toBe(L.istDayKey(Date.now()))
    expect(u.gameDayStaked).toBe(300)
  })

  test('a win counts back: the day\'s won grows by what was paid', async () => {
    db.seed('appConfig/games', cfg(0))
    for (let i = 0; i < 6; i += 1) await call(I.tossCoin, 'P', { entry: 10, side: 'heads', idempotencyKey: key() })
    const u = db.read('users/P')
    expect(u.gameDayStaked).toBe(60)
    expect(u.gameDayWon ?? 0).toBe(u.gameWon ?? 0)
  })
})

describe('match entries', () => {
  test('creating a table is refused over the limit — nothing moved', async () => {
    db.seed('appConfig/games', cfg(150))
    const today = L.istDayKey(Date.now())
    db.seed('users/P', { name: 'P', diamonds: 10_000, gameDayKey: today, gameDayStaked: 100, gameDayWon: 0 })
    const e = await refusal(call(MT.createGameMatch, 'P', { gameId: 'ludo', players: 2, entry: 100, idempotencyKey: key() }))
    expect(e && e.details && e.details.code).toBe(L.DAILY_LOSS_LIMIT)
    expect(db.read('users/P').diamonds).toBe(10_000)
  })
})

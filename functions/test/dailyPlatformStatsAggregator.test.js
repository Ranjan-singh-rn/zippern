/**
 * F-14 / M-16 — the daily revenue roll-up reads what settleGift writes, and
 * lands in its own collection.
 *
 * Before: `dailyPlatformStatsAggregator` queried `giftTransactions.timestamp`
 * and summed `beanValue`, while settleGift writes `createdAt` and
 * `beansCredited`, so every roll-up was zero; and it wrote that zero to
 * `platformRevenue/{YYYY-MM-DD}`, among the per-gift and per-call revenue rows.
 *
 * Here the gifts go through the real `settleGift` (lib/, as deployed), the
 * clock moves to the scheduled run just after the next midnight UTC, and the
 * day's roll-up must equal what was sent: in `platformRevenueDaily/{day}`,
 * and nowhere in `platformRevenue`.
 *
 * Run:  node --test test/dailyPlatformStatsAggregator.test.js
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test')
const { expect } = require('./expect')
const crypto = require('crypto')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
// Scheduled functions need a project id to describe themselves; a placeholder.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-daily-rollup'

const gifts = require('../lib/gifts')
const L = require('../lib/luckyGifts')
const index = require('../lib/index')

const DAY = '2026-11-01'
const at = (iso) => Date.parse(iso)
const ts = (iso) => Timestamp.fromMillis(at(iso))

const S = 'SENDER'
const R = 'RECEIVER'
const token = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
const send = (data) => gifts.settleGift.run({ data: { context: 'dm', ...data }, auth: { uid: S, token } })
const runRollup = () => index.dailyPlatformStatsAggregator.run({})
const rollup = () => db.read(`platformRevenueDaily/${DAY}`)

// `luckyGifts.ts` draws through `crypto.randomInt`; 0 is the ×5 bucket of the default table.
const realRandomInt = crypto.randomInt

beforeEach(() => {
  db._docs.clear()
  L.resetLuckyConfigCache()
  db.seed(`users/${S}`, { name: 'Sender', diamonds: 10_000 })
  db.seed(`users/${R}`, { name: 'Host', beans: 0, isHost: true, isVerifiedHost: true })
  db.seed('gifts/rose', { name: 'Rose', category: 'normal', diamondCost: 10, earningRate: 50, isActive: true })
  db.seed('gifts/lucky1', { name: 'Lucky Box', category: 'lucky', diamondCost: 100, earningRate: 5, isActive: true })
})
afterEach(() => {
  mock.timers.reset()
  crypto.randomInt = realRandomInt
})

/** A row in the shape settleGift writes, for the boundary cases. */
function giftRow(id, createdAtIso, extra = {}) {
  db.seed(`giftTransactions/${id}`, {
    senderUid: S, receiverUid: R, giftId: 'rose', quantity: 1, unitPrice: 100,
    diamondCost: 100, beansCredited: 50, receiverPct: 50, category: 'normal',
    context: 'dm', roomId: null, createdAt: ts(createdAtIso), ...extra,
  })
}

describe('the roll-up reads the fields settleGift writes', () => {
  test('a day of settleGift rows: spend, beans, lucky reward and profit add up', async () => {
    mock.timers.enable({ apis: ['Date'], now: at('2026-11-01T10:00:00Z') })
    const rose = await send({ giftId: 'rose', receiverUid: R, quantity: 3, idempotencyKey: 'g1' })
    crypto.randomInt = () => 0
    const lucky = await send({ giftId: 'lucky1', receiverUid: R, combo: 10, idempotencyKey: 'g2' })
    expect([rose.totalCost, rose.beansCredited]).toEqual([30, 15])
    expect([lucky.totalCost, lucky.beansCredited, lucky.lucky.reward]).toEqual([1000, 50, 500])

    mock.timers.setTime(at('2026-11-02T00:00:05Z'))      // the scheduled run, just after midnight UTC
    await runRollup()

    const day = rollup()
    expect(day.date).toBe(DAY)
    expect(day.totalTransactions).toBe(2)
    expect(day.totalGifts).toBe(13)                      // 3 roses and a combo of 10
    expect(day.totalDiamondSpend).toBe(1030)
    expect(day.totalBeanEarned).toBe(65)
    expect(day.totalLuckyReward).toBe(500)
    expect(day.platformProfit).toBe(1030 - 65 - 500)
    expect(day.platformRevenue).toBe(465)
    expect(day.platformPayout).toBe(65)
    expect(day.dayStart.toMillis()).toBe(at('2026-11-01T00:00:00Z'))
    expect(day.dayEnd.toMillis()).toBe(at('2026-11-01T23:59:59.999Z'))

    // It agrees with the per-gift revenue rows settleGift wrote beside the gifts.
    const cuts = db.all('platformRevenue').filter((r) => r.type === 'gift')
      .reduce((n, r) => n + r.platformCut, 0)
    expect(day.platformProfit).toBe(cuts)
  })

  test('the roll-up goes to platformRevenueDaily only; platformRevenue keeps one shape', async () => {
    mock.timers.enable({ apis: ['Date'], now: at('2026-11-01T10:00:00Z') })
    await send({ giftId: 'rose', receiverUid: R, quantity: 1, idempotencyKey: 'g1' })
    mock.timers.setTime(at('2026-11-02T00:00:05Z'))
    await runRollup()

    expect(db.count('platformRevenueDaily')).toBe(1)
    expect(db.has(`platformRevenue/${DAY}`)).toBe(false)
    const rows = db.all('platformRevenue')
    expect(rows.length).toBe(1)                          // settleGift's own row, nothing else
    expect(rows[0].type).toBe('gift')
  })
})

describe('the window is [00:00, next 00:00) UTC on createdAt', () => {
  test('both edges of the day are counted, the neighbouring days are not; a re-run overwrites', async () => {
    giftRow('before', '2026-10-31T23:59:59.999Z')
    giftRow('first', '2026-11-01T00:00:00.000Z')
    giftRow('last', '2026-11-01T23:59:59.999Z', { quantity: 2, diamondCost: 200, beansCredited: 100 })
    giftRow('after', '2026-11-02T00:00:00.000Z')
    mock.timers.enable({ apis: ['Date'], now: at('2026-11-02T00:00:05Z') })

    await runRollup()
    const day = rollup()
    expect(day.totalTransactions).toBe(2)
    expect(day.totalGifts).toBe(3)
    expect(day.totalDiamondSpend).toBe(300)
    expect(day.totalBeanEarned).toBe(150)
    expect(day.totalLuckyReward).toBe(0)
    expect(day.platformProfit).toBe(150)

    await runRollup()                                    // same day again: replaced, not added to
    expect(rollup().totalDiamondSpend).toBe(300)
    expect(db.count('platformRevenueDaily')).toBe(1)
  })

  test('a read failure writes no roll-up, rather than a zero for a day that may have had gifts', async () => {
    mock.timers.enable({ apis: ['Date'], now: at('2026-11-02T00:00:05Z') })
    giftRow('first', '2026-11-01T09:00:00Z')
    const original = db.collection
    db.collection = function (name) {
      if (name !== 'giftTransactions') return original.call(this, name)
      const failing = { where: () => failing, get: async () => { throw new Error('14 UNAVAILABLE') } }
      return failing
    }
    try {
      await runRollup()
    } finally {
      db.collection = original
    }
    expect(db.count('platformRevenueDaily')).toBe(0)
    expect(db.count('platformRevenue')).toBe(0)
  })
})

describe('the deployed shape is unchanged', () => {
  test('same export, schedule and time zone; still no .region() (us-central1)', () => {
    const ep = index.dailyPlatformStatsAggregator.__endpoint
    expect(ep.scheduleTrigger.schedule).toBe('0 0 * * *')
    expect(ep.scheduleTrigger.timeZone).toBe('UTC')
    expect(ep.region).toBe(undefined)
  })
})

/**
 * Lucky gifts as combos — the configuration guard, the roll, the arithmetic,
 * and `settleGift` run end to end against the in-memory Firestore.
 *
 * The spec example: unit 100, combo 17 → the sender pays 1,700, the receiver
 * earns 85 beans (5%), the sender's reward is multiplier × 100 — between 500
 * (×5) and 10,000 (×100) — credited in the SAME transaction as the charge.
 *
 * Lucky gifts are OFF unless the Owner's switch is on
 * (`appConfig/luckyGifts.enabled === true`). The tests that exercise the
 * mechanics seed the switch on; "the Owner's switch" below covers it off.
 *
 * Run:  node --test test/luckyGifts.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('crypto')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const L = require('../lib/luckyGifts')
const gifts = require('../lib/gifts')

const S = 'SENDER'
const R = 'RECEIVER'
const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
const send = (data) => gifts.settleGift.run({ data: { context: 'dm', idempotencyKey: 'k1', ...data }, auth: { uid: S, token: token() } })
async function refusal(p) { try { await p } catch (e) { return e } return null }

const DEFAULT_TOTAL = 100_000   // Σ weight × 1000 for the default table

// ── Stubbing the roll ────────────────────────────────────────────────────────
// `luckyGifts.ts` calls `crypto.randomInt` through the module object, so the
// property can be replaced for a test and restored afterwards.
const realRandomInt = crypto.randomInt
const rollLog = []
function stubRoll(value) {
  crypto.randomInt = (min, max) => { rollLog.push([min, max]); return value }
}
afterEach(() => { crypto.randomInt = realRandomInt; rollLog.length = 0 })

// ── Recording reads ──────────────────────────────────────────────────────────
// Every document read in the fake goes through DocRef#get — a transaction's
// `tx.get` included — so wrapping it records which documents a send read, in
// order. `onRead` runs after the snapshot is taken (the fake's get is
// synchronous up to its return), so it can change the document for the NEXT
// read without changing this one.
const DocRefProto = Object.getPrototypeOf(db.collection('_').doc('_'))
const realDocGet = DocRefProto.get
const reads = []
function recordReads(onRead) {
  reads.length = 0
  DocRefProto.get = function () {
    reads.push(this.path)
    const snap = realDocGet.call(this)
    if (onRead) onRead(this.path)
    return snap
  }
}
afterEach(() => { DocRefProto.get = realDocGet; reads.length = 0 })

// ══ The pure parts ═══════════════════════════════════════════════════════════

describe('the payout guard', () => {
  test('the default table is accepted: E = 7.45 against a ceiling of 8.55', () => {
    const v = L.validateLuckyConfig(undefined)
    expect(v.ok).toBe(true)
    expect(Math.round(v.expectedMultiplier * 1000) / 1000).toBe(7.45)
    expect(Math.round(v.ceiling * 1000) / 1000).toBe(8.55)
    expect(v.config.combos).toEqual([10, 17, 25, 77])
    expect(v.config.receiverPct).toBe(5)
    expect(v.config.version).toBe(0)
  })

  test('the formula: ceiling = minCombo × (1 − receiverPct/100) × 0.9', () => {
    expect(L.luckyPayoutCeiling({ combos: [10, 17], receiverPct: 5 })).toBe(10 * 0.95 * 0.9)
    expect(L.luckyPayoutCeiling({ combos: [77, 20], receiverPct: 50 })).toBe(20 * 0.5 * 0.9)
    expect(L.expectedMultiplier([{ multiplier: 5, weight: 1 }, { multiplier: 15, weight: 1 }])).toBe(10)
  })

  test('a losing table is refused with the reason', () => {
    const v = L.validateLuckyConfig({ version: 3, odds: [{ multiplier: 5, weight: 50 }, { multiplier: 100, weight: 50 }] })
    expect(v.ok).toBe(false)
    expect(v.code).toBe('LUCKY_PAYOUT_GUARD')
    expect(v.reason.includes('52.500')).toBe(true)
    expect(v.reason.includes('8.550')).toBe(true)
  })

  test('the guard moves with the smallest combo and the receiver share', () => {
    // E = 7.45; a smallest combo of 8 is not allowed at all, 10 at 20% to the receiver gives 7.2 → refused
    expect(L.validateLuckyConfig({ receiverPct: 20 }).ok).toBe(false)
    expect(L.validateLuckyConfig({ receiverPct: 20 }).code).toBe('LUCKY_PAYOUT_GUARD')
    // …and a smallest combo of 11 at 20% gives 7.92 → accepted
    expect(L.validateLuckyConfig({ receiverPct: 20, combos: [11, 77] }).ok).toBe(true)
    // exactly at the ceiling passes (not above)
    const v = L.validateLuckyConfig({ combos: [10], receiverPct: 0, odds: [{ multiplier: 9, weight: 1 }] })
    expect(v.ok).toBe(true)
    expect(v.ceiling).toBe(9)
  })

  test('multipliers must be whole numbers from 5 to 100, weights > 0, combos whole numbers ≥ 10', () => {
    const bad = (doc, code) => { const v = L.validateLuckyConfig(doc); expect(v.ok).toBe(false); expect(v.code).toBe(code) }
    bad({ odds: [{ multiplier: 4, weight: 1 }] }, 'LUCKY_ODDS')
    bad({ odds: [{ multiplier: 101, weight: 1 }] }, 'LUCKY_ODDS')
    bad({ odds: [{ multiplier: 5.5, weight: 1 }] }, 'LUCKY_ODDS')
    bad({ odds: [{ multiplier: 5, weight: 0 }] }, 'LUCKY_ODDS')
    bad({ odds: [{ multiplier: 5, weight: -1 }] }, 'LUCKY_ODDS')
    bad({ odds: [{ multiplier: 5, weight: 0.0001 }] }, 'LUCKY_ODDS')
    bad({ odds: [] }, 'LUCKY_ODDS')
    bad({ odds: 'nope' }, 'LUCKY_ODDS')
    bad({ combos: [9, 17] }, 'LUCKY_COMBOS')
    bad({ combos: [10.5] }, 'LUCKY_COMBOS')
    bad({ combos: [10, 10] }, 'LUCKY_COMBOS')
    bad({ combos: [] }, 'LUCKY_COMBOS')
    bad({ receiverPct: 101 }, 'LUCKY_RECEIVER_PCT')
    bad({ receiverPct: -1 }, 'LUCKY_RECEIVER_PCT')
    bad({ version: -1 }, 'LUCKY_VERSION')
  })

  test('the [multiplier, weight] shorthand is accepted and combos are sorted', () => {
    const v = L.validateLuckyConfig({ version: 2, combos: [77, 10, 25], odds: [[5, 84], [10, 10], [25, 4], [50, 1.5], [100, 0.5]] })
    expect(v.ok).toBe(true)
    expect(v.config.combos).toEqual([10, 25, 77])
    expect(v.config.odds[3]).toEqual({ multiplier: 50, weight: 1.5 })
    expect(v.config.version).toBe(2)
  })
})

describe('the settlement arithmetic (spec example: unit 100, combo 17)', () => {
  test('pays 1,700; receiver 85; reward 500 at ×5; Zipper keeps 1,115', () => {
    expect(L.luckySettlement({ unit: 100, combo: 17, receiverPct: 5, multiplier: 5 }))
      .toEqual({ charge: 1700, receiverBeans: 85, reward: 500, platformCut: 1115 })
  })
  test('at ×100 the reward is 10,000 and the line is −8,385, recorded as is', () => {
    expect(L.luckySettlement({ unit: 100, combo: 17, receiverPct: 5, multiplier: 100 }))
      .toEqual({ charge: 1700, receiverBeans: 85, reward: 10000, platformCut: -8385 })
  })
  test('the receiver share floors', () => {
    expect(L.luckySettlement({ unit: 7, combo: 10, receiverPct: 5, multiplier: 5 }).receiverBeans).toBe(3)   // 3.5 → 3
  })
})

describe('the roll', () => {
  const odds = L.LUCKY_DEFAULTS.odds

  test('walks the weighted table: each bucket\'s edges land on its multiplier', () => {
    const cases = [
      [0, 5], [83_999, 5], [84_000, 10], [93_999, 10], [94_000, 25], [97_999, 25],
      [98_000, 50], [99_499, 50], [99_500, 100], [99_999, 100],
    ]
    for (const [roll, multiplier] of cases) {
      const r = L.rollLuckyMultiplier(odds, () => roll)
      expect(r.multiplier).toBe(multiplier)
      expect(r.roll).toBe(roll)
      expect(r.total).toBe(DEFAULT_TOTAL)
    }
  })

  test('asks crypto.randomInt for [0, Σweight×1000) when no draw is injected', () => {
    stubRoll(94_000)
    const r = L.rollLuckyMultiplier(odds)
    expect(r.multiplier).toBe(25)
    expect(rollLog).toEqual([[0, DEFAULT_TOTAL]])
  })

  test('a draw outside the table is refused rather than mapped', () => {
    expect(() => L.rollLuckyMultiplier(odds, () => DEFAULT_TOTAL)).toThrow(/outside/)
    expect(() => L.rollLuckyMultiplier(odds, () => -1)).toThrow(/outside/)
    expect(() => L.rollLuckyMultiplier(odds, () => 1.5)).toThrow(/outside/)
  })

  test('with the real generator every draw is a configured multiplier', () => {
    const allowed = new Set(odds.map((o) => o.multiplier))
    for (let i = 0; i < 2000; i++) expect(allowed.has(L.rollLuckyMultiplier(odds).multiplier)).toBe(true)
  })

  test('the recorded hash binds the roll to the transaction and the table version', () => {
    const h = L.luckyRollHash({ transactionId: 'T1', configVersion: 0, roll: 5, total: DEFAULT_TOTAL })
    expect(h).toBe(crypto.createHash('sha256').update('lucky:T1:0:5:100000').digest('hex'))
    expect(h).not.toBe(L.luckyRollHash({ transactionId: 'T1', configVersion: 1, roll: 5, total: DEFAULT_TOTAL }))
  })
})

// ══ settleGift, end to end ═══════════════════════════════════════════════════

const LUCKY = { name: 'Lucky Box', emoji: '🎲', category: 'lucky', diamondCost: 100, earningRate: 5, isActive: true }
const ROSE = { name: 'Rose', emoji: '🌹', category: 'normal', diamondCost: 10, earningRate: 50, isActive: true }

/** The Owner's switch on, nothing else: the table is the documented defaults (version 0). */
const ON = Object.freeze({ enabled: true })

/** `luckyDoc: null` leaves `appConfig/luckyGifts` absent. */
function seedWorld({ senderDiamonds = 5000, luckyDoc = ON } = {}) {
  db._docs.clear()
  L.resetLuckyConfigCache()
  db.seed(`users/${S}`, { name: 'Sender', diamonds: senderDiamonds })
  db.seed(`users/${R}`, { name: 'Host', beans: 0, isHost: true, isVerifiedHost: true })
  db.seed('gifts/lucky1', LUCKY)
  db.seed('gifts/rose', ROSE)
  if (luckyDoc) db.seed('appConfig/luckyGifts', luckyDoc)
}
const sender = () => db.read(`users/${S}`)
const receiver = () => db.read(`users/${R}`)
const giftRows = () => db.all('giftTransactions')
const senderDiamondRows = () => db.all(`users/${S}/diamondTransactions`)

describe('settleGift: a lucky combo', () => {
  beforeEach(() => seedWorld())

  test('unit 100 × combo 17 at ×5: pays 1,700, receiver 85, reward 500 — all in one commit', async () => {
    stubRoll(0)
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })
    expect(r.replayed).toBe(false)
    expect(r.totalCost).toBe(1700)
    expect(r.beansCredited).toBe(85)
    expect(r.receiverPct).toBe(5)
    expect(r.quantity).toBe(17)
    expect(r.lucky).toEqual({ combo: 17, unit: 100, multiplier: 5, reward: 500, configVersion: 0 })
    expect(rollLog).toEqual([[0, DEFAULT_TOTAL]])        // crypto.randomInt, once, over the whole table

    expect(sender().diamonds).toBe(5000 - 1700 + 500)
    expect(sender().totalGemsSpent).toBe(1700)
    expect(sender().luckyRewardsWon).toBe(500)
    expect(receiver().beans).toBe(85)
    expect(receiver().hostGiftEarnings).toBe(85)
    expect(receiver().totalGiftsReceived).toBe(17)

    // The private record carries the roll in full.
    const [row] = giftRows()
    expect(row.diamondCost).toBe(1700)
    expect(row.beansCredited).toBe(85)
    expect(row.quantity).toBe(17)
    expect(row.category).toBe('lucky')
    expect(row.lucky.combo).toBe(17)
    expect(row.lucky.unit).toBe(100)
    expect(row.lucky.multiplier).toBe(5)
    expect(row.lucky.reward).toBe(500)
    expect(row.lucky.configVersion).toBe(0)
    expect(row.lucky.roll).toBe(0)
    expect(row.lucky.rollTotal).toBe(DEFAULT_TOTAL)
    expect(row.lucky.rollSeedHash).toBe(L.luckyRollHash({ transactionId: row.id, configVersion: 0, roll: 0, total: DEFAULT_TOTAL }))

    // Two ledger rows on the sender: the charge and the reward.
    const rows = senderDiamondRows()
    const debit = rows.find((x) => x.type === 'debit')
    const credit = rows.find((x) => x.type === 'credit')
    expect(debit.amount).toBe(1700)
    expect(debit.balanceAfter).toBe(3300)
    expect(debit.reason).toBe('gift_sent')
    expect(credit.amount).toBe(500)
    expect(credit.balanceAfter).toBe(3800)
    expect(credit.reason).toBe('lucky_gift_reward')
    expect(credit.transactionId).toBe(row.id)
    expect(credit.lucky.multiplier).toBe(5)

    // The receiver's earnings paths are the normal ones.
    const bean = db.all(`users/${R}/beanTransactions`)[0]
    expect(bean.amount).toBe(85)
    expect(bean.reason).toBe('gift_received')
    expect(db.all(`users/${R}/weeklyEarnings`)[0].giftBeans).toBe(85)
    expect(db.all(`users/${R}/dailyStats`)[0].giftsReceived).toBe(17)

    // Zipper's line: 1,700 − 85 − 500.
    const [rev] = db.all('platformRevenue')
    expect(rev.subType).toBe('lucky')
    expect(rev.grossDiamonds).toBe(1700)
    expect(rev.payoutBeans).toBe(85)
    expect(rev.luckyReward).toBe(500)
    expect(rev.platformCut).toBe(1115)
    // The room-facing event names the win without the roll internals.
    const [ev] = db.all('giftEvents')
    expect(ev.lucky).toEqual({ combo: 17, multiplier: 5, reward: 500 })
    expect(ev.totalCost).toBe(1700)
  })

  test('a ×100 win: reward 10,000; the platform line goes to −8,385 and is recorded as is', async () => {
    stubRoll(99_999)
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })
    expect(r.lucky.multiplier).toBe(100)
    expect(r.lucky.reward).toBe(10000)
    expect(sender().diamonds).toBe(5000 - 1700 + 10000)
    expect(receiver().beans).toBe(85)
    expect(db.all('platformRevenue')[0].platformCut).toBe(-8385)
  })

  test('each configured multiplier reaches the sender as its reward', async () => {
    for (const [roll, multiplier] of [[0, 5], [84_000, 10], [94_000, 25], [98_000, 50], [99_500, 100]]) {
      seedWorld()
      stubRoll(roll)
      const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 10 })
      expect(r.lucky.multiplier).toBe(multiplier)
      expect(r.lucky.reward).toBe(multiplier * 100)
      expect(sender().diamonds).toBe(5000 - 1000 + multiplier * 100)
    }
  })

  test('with the real generator the reward lies in [500, 10,000] and is a configured multiple of the unit', async () => {
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })
    expect(r.lucky.reward).toBeGreaterThanOrEqual(500)
    expect(r.lucky.reward).toBeLessThanOrEqual(10000)
    expect([5, 10, 25, 50, 100].includes(r.lucky.multiplier)).toBe(true)
    expect(r.lucky.reward).toBe(r.lucky.multiplier * 100)
    expect(sender().diamonds).toBe(5000 - 1700 + r.lucky.reward)
  })

  test('the configured document is what runs: version, combos, share and odds', async () => {
    seedWorld({ luckyDoc: { enabled: true, version: 7, combos: [20, 50], receiverPct: 10, odds: [{ multiplier: 5, weight: 1 }, { multiplier: 10, weight: 1 }] } })
    stubRoll(1500)                                           // second bucket of 2 × 1000
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 20 })
    expect(r.lucky).toEqual({ combo: 20, unit: 100, multiplier: 10, reward: 1000, configVersion: 7 })
    expect(r.totalCost).toBe(2000)
    expect(r.beansCredited).toBe(200)                        // 10%, not the gift's earningRate of 5
    expect(rollLog).toEqual([[0, 2000]])
  })

  test('a combo that is not configured is rejected before anything is written', async () => {
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 12 }))
    expect(e && e.code).toBe('invalid-argument')
    expect(e.message).toBe('Lucky gifts are sent as a combo of 10, 17, 25, 77.')
    expect(sender().diamonds).toBe(5000)
    expect(giftRows().length).toBe(0)
    expect(db.count('giftIdempotency')).toBe(0)
    expect(rollLog.length).toBe(0)
  })

  test('a lucky gift without a combo, and a normal gift with one, are both rejected', async () => {
    const noCombo = await refusal(send({ giftId: 'lucky1', receiverUid: R, quantity: 17 }))
    expect(noCombo && noCombo.code).toBe('invalid-argument')
    expect(noCombo.message.includes('combo')).toBe(true)
    const comboOnRose = await refusal(send({ giftId: 'rose', receiverUid: R, combo: 17 }))
    expect(comboOnRose && comboOnRose.code).toBe('invalid-argument')
    expect(sender().diamonds).toBe(5000)
    expect(giftRows().length).toBe(0)
  })

  test('a quantity beside the combo must be 1 or the combo itself', async () => {
    expect((await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17, quantity: 3 }))).code).toBe('invalid-argument')
    stubRoll(0)
    expect((await send({ giftId: 'lucky1', receiverUid: R, combo: 17, quantity: 1 })).totalCost).toBe(1700)
    seedWorld()
    stubRoll(0)
    expect((await send({ giftId: 'lucky1', receiverUid: R, combo: 17, quantity: 17 })).totalCost).toBe(1700)
  })

  test('a replay with the same idempotency key charges nothing and returns the same win', async () => {
    stubRoll(99_500)
    const first = await send({ giftId: 'lucky1', receiverUid: R, combo: 25 })
    const balance = sender().diamonds
    stubRoll(0)                                              // a different draw, were it to roll again
    const again = await send({ giftId: 'lucky1', receiverUid: R, combo: 25 })
    expect(again.replayed).toBe(true)
    expect(again.lucky.multiplier).toBe(100)
    expect(again.transactionId).toBe(first.transactionId)
    expect(sender().diamonds).toBe(balance)
    expect(giftRows().length).toBe(1)
    expect(senderDiamondRows().length).toBe(2)
    expect(rollLog.length).toBe(1)                           // the replay did not roll
  })

  test('insufficient balance refuses before any write — and before the roll', async () => {
    seedWorld({ senderDiamonds: 1699 })
    stubRoll(0)
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17 }))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('Not enough diamonds. This costs 1700, you have 1699.')
    expect(sender().diamonds).toBe(1699)
    expect(receiver().beans).toBe(0)
    expect(giftRows().length).toBe(0)
    expect(senderDiamondRows().length).toBe(0)
    expect(db.count('giftIdempotency')).toBe(0)
    expect(db.count('platformRevenue')).toBe(0)
    expect(rollLog.length).toBe(0)
    // Exactly enough is enough.
    seedWorld({ senderDiamonds: 1700 })
    stubRoll(0)
    expect((await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })).totalCost).toBe(1700)
  })
})

describe('settleGift: the guard at read time', () => {
  const LOSING = { enabled: true, version: 9, odds: [{ multiplier: 5, weight: 50 }, { multiplier: 100, weight: 50 }] }

  test('a losing table with no earlier valid version refuses the send with a clear error, nothing written', async () => {
    seedWorld({ luckyDoc: LOSING })
    stubRoll(0)
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17 }))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('Lucky gifts are unavailable right now.')
    expect(e.details.code).toBe('LUCKY_PAYOUT_GUARD')
    expect(sender().diamonds).toBe(5000)
    expect(giftRows().length).toBe(0)
    expect(db.count('giftIdempotency')).toBe(0)
    expect(rollLog.length).toBe(0)
  })

  test('a losing table after a valid one: the last valid version is used, never a built-in table', async () => {
    seedWorld({ luckyDoc: { enabled: true, version: 4, combos: [10, 17], receiverPct: 5, odds: [[5, 90], [10, 10]] } })
    stubRoll(0)
    const first = await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })
    expect(first.lucky.configVersion).toBe(4)
    // The CRM saves a losing table (this would be refused there too).
    db.seed('appConfig/luckyGifts', LOSING)
    stubRoll(0)
    const second = await send({ giftId: 'lucky1', receiverUid: R, combo: 17, idempotencyKey: 'k2' })
    expect(second.lucky.configVersion).toBe(4)               // not 9, and not the defaults (0)
    expect(second.lucky.multiplier).toBe(5)
    expect(rollLog).toEqual([[0, 100_000], [0, 100_000]])    // version 4's table both times
  })

  test('an enabled document with no table runs on the default table, recorded as version 0', async () => {
    seedWorld({ senderDiamonds: 10_000, luckyDoc: { enabled: true } })
    stubRoll(0)
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 77 })
    expect(r.lucky.configVersion).toBe(0)
    expect(r.totalCost).toBe(7700)
    expect(r.beansCredited).toBe(385)                        // the default 5%
    expect(rollLog).toEqual([[0, DEFAULT_TOTAL]])            // the default odds
  })

  test('an enabled document missing some fields takes the defaults for those only', async () => {
    seedWorld({ luckyDoc: { enabled: true, version: 5, receiverPct: 3 } })
    stubRoll(0)
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 25 })
    expect(r.lucky.configVersion).toBe(5)
    expect(r.beansCredited).toBe(75)                         // 3% of 2,500, from the document
    expect(rollLog).toEqual([[0, DEFAULT_TOTAL]])            // odds absent → the default table
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 12, idempotencyKey: 'k2' }))
    expect(e.message).toBe('Lucky gifts are sent as a combo of 10, 17, 25, 77.')   // combos absent → defaults
  })
})

// ══ The Owner's switch ═══════════════════════════════════════════════════════

describe('settleGift: the Owner\'s switch (appConfig/luckyGifts.enabled)', () => {
  const OFF_MESSAGE = 'Lucky gifts are not available right now.'
  const TABLE = { version: 3, combos: [10, 17, 25, 77], receiverPct: 5, odds: [[5, 84], [10, 10], [25, 4], [50, 1.5], [100, 0.5]] }

  /** A refusal of the switch: the code, the sentence, the details code. */
  function expectSwitchRefusal(e) {
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe(OFF_MESSAGE)
    expect(e.details).toEqual({ code: 'LUCKY_GIFTS_DISABLED' })
  }

  /** Nothing moved: no write or delete of any kind, the balances as seeded, no row, no claim, no roll. */
  function expectNothingWritten(before) {
    expect(db.writes).toBe(before.writes)
    expect(db.deletes).toBe(before.deletes)
    expect(sender().diamonds).toBe(5000)
    expect(sender().totalGemsSpent).toBe(undefined)
    expect(receiver().beans).toBe(0)
    expect(giftRows().length).toBe(0)
    expect(senderDiamondRows().length).toBe(0)
    expect(db.count(`users/${R}/beanTransactions`)).toBe(0)
    expect(db.count('giftIdempotency')).toBe(0)
    expect(db.count('giftEvents')).toBe(0)
    expect(db.count('platformRevenue')).toBe(0)
    expect(rollLog.length).toBe(0)
  }
  const counters = () => ({ writes: db.writes, deletes: db.deletes })

  test('pure: only an existing document whose enabled is exactly true is on', () => {
    expect(L.luckyGiftsEnabled(undefined, false)).toBe(false)
    expect(L.luckyGiftsEnabled({ enabled: true }, false)).toBe(false)
    expect(L.luckyGiftsEnabled({ enabled: true }, true)).toBe(true)
    for (const enabled of [false, 'true', 1, null, undefined, {}]) {
      expect(L.luckyGiftsEnabled({ enabled }, true)).toBe(false)
    }
    expect(L.luckyGiftsEnabled({ ...TABLE }, true)).toBe(false)           // a table without the switch is off
    expect(L.LUCKY_GIFTS_DISABLED).toBe('LUCKY_GIFTS_DISABLED')
    expect(L.LUCKY_GIFTS_DISABLED_MESSAGE).toBe(OFF_MESSAGE)
    // The guard does not read the switch: the same verdict either way.
    expect(L.validateLuckyConfig({ ...TABLE, enabled: false })).toEqual(L.validateLuckyConfig({ ...TABLE, enabled: true }))
    expect(L.validateLuckyConfig({ enabled: true }).ok).toBe(true)
  })

  test('document absent: the lucky send is refused before anything else is read, nothing written', async () => {
    seedWorld({ luckyDoc: null })
    stubRoll(0)
    const before = counters()
    recordReads()
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17 }))
    expectSwitchRefusal(e)
    // The switch is the ONLY document read: not the account, not either balance.
    expect(reads).toEqual(['appConfig/luckyGifts'])
    expectNothingWritten(before)
  })

  test('enabled: false refuses the same way, whatever the table says; so does any value but true', async () => {
    for (const luckyDoc of [{ ...TABLE, enabled: false }, { ...TABLE }, { ...TABLE, enabled: 'true' }, { ...TABLE, enabled: 1 }]) {
      seedWorld({ luckyDoc })
      stubRoll(0)
      const before = counters()
      recordReads()
      const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17 }))
      expectSwitchRefusal(e)
      expect(reads).toEqual(['appConfig/luckyGifts'])
      expect(reads.includes(`users/${S}`)).toBe(false)
      expectNothingWritten(before)
    }
  })

  test('a broke sender is told the switch is off, not that the balance is short', async () => {
    seedWorld({ senderDiamonds: 0, luckyDoc: { ...TABLE, enabled: false } })
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 10 }))
    expectSwitchRefusal(e)
    expect(sender().diamonds).toBe(0)
  })

  test('enabled: true runs the mechanics unchanged: charge, receiver share, roll and reward in one commit', async () => {
    seedWorld({ luckyDoc: { ...TABLE, enabled: true } })
    stubRoll(94_000)                                         // the ×25 bucket
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 17 })
    expect(r.lucky).toEqual({ combo: 17, unit: 100, multiplier: 25, reward: 2500, configVersion: 3 })
    expect(r.totalCost).toBe(1700)
    expect(r.beansCredited).toBe(85)
    expect(sender().diamonds).toBe(5000 - 1700 + 2500)
    expect(receiver().beans).toBe(85)
    expect(db.all('platformRevenue')[0].platformCut).toBe(1700 - 85 - 2500)
  })

  test('a normal gift is unaffected in all three states, and never reads the switch', async () => {
    for (const luckyDoc of [null, { ...TABLE, enabled: false }, { ...TABLE, enabled: true }]) {
      seedWorld({ luckyDoc })
      stubRoll(0)
      recordReads()
      const r = await send({ giftId: 'rose', receiverUid: R, quantity: 3 })
      expect(r.replayed).toBe(false)
      expect(r.totalCost).toBe(30)
      expect(r.beansCredited).toBe(15)
      expect(r.receiverPct).toBe(50)
      expect(r.lucky).toBe(undefined)
      expect(sender().diamonds).toBe(4970)
      expect(receiver().beans).toBe(15)
      expect(giftRows().length).toBe(1)
      expect(db.all('platformRevenue')[0].platformCut).toBe(15)
      expect(rollLog.length).toBe(0)
      expect(reads.includes('appConfig/luckyGifts')).toBe(false)
    }
  })

  test('a lucky gift sent without a combo while off is refused LUCKY_GIFTS_DISABLED too, nothing written', async () => {
    seedWorld({ luckyDoc: { ...TABLE, enabled: false } })
    const before = counters()
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, quantity: 17 }))
    expectSwitchRefusal(e)
    expectNothingWritten(before)
  })

  test('switched off between the early read and the transaction: the transaction\'s own read refuses, nothing written', async () => {
    seedWorld({ luckyDoc: { ...TABLE, enabled: true } })
    stubRoll(0)
    const before = counters()
    let flipped = false
    recordReads((path) => {
      if (path === 'appConfig/luckyGifts' && !flipped) {
        flipped = true
        db.seed('appConfig/luckyGifts', { ...TABLE, enabled: false })   // the Owner switches off mid-send
      }
    })
    const e = await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 17 }))
    expectSwitchRefusal(e)
    expect(reads.filter((p) => p === 'appConfig/luckyGifts').length).toBe(2)   // early, then under the transaction
    expectNothingWritten(before)
  })

  test('switched back on: the stored table runs again', async () => {
    seedWorld({ luckyDoc: { ...TABLE, enabled: false } })
    expectSwitchRefusal(await refusal(send({ giftId: 'lucky1', receiverUid: R, combo: 10 })))
    db.seed('appConfig/luckyGifts', { ...TABLE, version: 4, enabled: true })
    stubRoll(0)
    const r = await send({ giftId: 'lucky1', receiverUid: R, combo: 10, idempotencyKey: 'k2' })
    expect(r.lucky.configVersion).toBe(4)
    expect(r.lucky.reward).toBe(500)
    expect(sender().diamonds).toBe(5000 - 1000 + 500)
  })
})

describe('settleGift: a normal gift is settled exactly as before', () => {
  beforeEach(() => seedWorld())

  test('Rose ×3 at 50%: pays 30, receiver 15, no reward, no lucky field, no roll', async () => {
    stubRoll(0)
    const r = await send({ giftId: 'rose', receiverUid: R, quantity: 3 })
    expect(r.totalCost).toBe(30)
    expect(r.beansCredited).toBe(15)
    expect(r.receiverPct).toBe(50)
    expect(r.quantity).toBe(3)
    expect(r.lucky).toBe(undefined)
    expect(rollLog.length).toBe(0)
    expect(sender().diamonds).toBe(4970)
    expect(sender().luckyRewardsWon).toBe(undefined)
    expect(receiver().beans).toBe(15)
    const [row] = giftRows()
    expect(row.lucky).toBe(undefined)
    expect(senderDiamondRows().length).toBe(1)
    expect(db.all('platformRevenue')[0].platformCut).toBe(15)
    expect(db.all('platformRevenue')[0].luckyReward).toBe(undefined)
  })

  test('quantity is still required for a normal gift', async () => {
    const e = await refusal(send({ giftId: 'rose', receiverUid: R }))
    expect(e && e.code).toBe('invalid-argument')
    expect(e.message).toBe('quantity must be 1–9999.')
  })
})

/**
 * F-18 — settleGift's money math for a NORMAL gift, run end to end against the
 * in-memory Firestore (lib/, as deployed).
 *
 * luckyGifts.test.js already covers the lucky combo in full and one normal
 * gift (Rose x3 at 50%: totals, one debit row, the platform cut). What it does
 * not cover, and this file does:
 *
 *   * the receiver share FLOORS: beans = floor(cost x pct / 100) on a share
 *     that does not divide evenly, and every balance and counter it moves;
 *   * the ledger rows in full: the sender's debit, the receiver's credit, the
 *     private gift record, the revenue and event rows, all tied by one
 *     transaction id;
 *   * an idempotent REPLAY of a normal gift: same answer, nothing charged twice;
 *   * where pct comes from: the gift's own `earningRate`, else the category
 *     rate in appConfig/economy, else 50.
 *
 * Run:  node --test test/settleGiftNormal.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const gifts = require('../lib/gifts')

const S = 'SENDER'
const R = 'RECEIVER'
const token = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
const send = (data) => gifts.settleGift.run({ data: { context: 'dm', ...data }, auth: { uid: S, token } })

// Crown: 33 diamonds at 52%. Three of them cost 99; 99 x 52 / 100 = 51.48 -> 51 beans.
const CROWN = { name: 'Crown', emoji: '👑', category: 'normal', diamondCost: 33, earningRate: 52, isActive: true }

beforeEach(() => {
  db._docs.clear()
  db.seed(`users/${S}`, { name: 'Sender', displayName: 'Sender', diamonds: 5000 })
  db.seed(`users/${R}`, { name: 'Host', displayName: 'Host', beans: 40, isHost: true, isVerifiedHost: true })
  db.seed('gifts/crown', CROWN)
})

const sender = () => db.read(`users/${S}`)
const receiver = () => db.read(`users/${R}`)

describe('a normal gift: debit, credit and the floor', () => {
  test('Crown x3 at 52%: the sender pays 99, the receiver earns floor(51.48) = 51', async () => {
    const r = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k1' })
    expect(r.replayed).toBe(false)
    expect(r.totalCost).toBe(99)
    expect(r.receiverPct).toBe(52)
    expect(r.beansCredited).toBe(51)
    expect(r.quantity).toBe(3)

    expect(sender().diamonds).toBe(5000 - 99)
    expect(sender().totalGemsSpent).toBe(99)
    expect(receiver().beans).toBe(40 + 51)
    expect(receiver().totalBeansEarned).toBe(51)
    expect(receiver().hostGiftEarnings).toBe(51)
    expect(receiver().totalGiftsReceived).toBe(3)
    // Banked against this IST week for the weekly release, in the same commit.
    const [wk] = db.all(`users/${R}/weeklyEarnings`)
    expect(wk.beans).toBe(51)
    expect(wk.giftBeans).toBe(51)
    expect(wk.released).toBe(false)
  })

  test('the ledger rows, all tied to one transaction id', async () => {
    const r = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k1' })
    const id = r.transactionId

    const [gt] = db.all('giftTransactions')
    expect(gt.id).toBe(id)
    expect(gt.senderUid).toBe(S)
    expect(gt.receiverUid).toBe(R)
    expect(gt.quantity).toBe(3)
    expect(gt.unitPrice).toBe(33)
    expect(gt.diamondCost).toBe(99)
    expect(gt.beansCredited).toBe(51)
    expect(gt.receiverPct).toBe(52)
    expect(gt.category).toBe('normal')
    expect(typeof gt.createdAt.toMillis).toBe('function')
    expect(gt.lucky).toBe(undefined)

    const debits = db.all(`users/${S}/diamondTransactions`)
    expect(debits.length).toBe(1)
    expect(debits[0].type).toBe('debit')
    expect(debits[0].amount).toBe(99)
    expect(debits[0].balanceAfter).toBe(4901)
    expect(debits[0].reason).toBe('gift_sent')
    expect(debits[0].relatedUid).toBe(R)
    expect(debits[0].quantity).toBe(3)
    expect(debits[0].transactionId).toBe(id)

    const credits = db.all(`users/${R}/beanTransactions`)
    expect(credits.length).toBe(1)
    expect(credits[0].type).toBe('credit')
    expect(credits[0].amount).toBe(51)
    expect(credits[0].balanceAfter).toBe(91)
    expect(credits[0].reason).toBe('gift_received')
    expect(credits[0].relatedUid).toBe(S)
    expect(credits[0].diamondCost).toBe(99)
    expect(credits[0].receiverPct).toBe(52)
    expect(credits[0].transactionId).toBe(id)

    const [rev] = db.all('platformRevenue')
    expect(rev.type).toBe('gift')
    expect(rev.grossDiamonds).toBe(99)
    expect(rev.payoutBeans).toBe(51)
    expect(rev.platformCut).toBe(48)
    expect(rev.transactionId).toBe(id)

    const [ev] = db.all('giftEvents')
    expect(ev.totalCost).toBe(99)
    expect(ev.beansEarned).toBe(51)
    expect(ev.quantity).toBe(3)

    expect(db.read(`giftIdempotency/${S}_k1`).transactionId).toBe(id)
  })
})

describe('a normal gift replayed with the same idempotency key', () => {
  test('returns the first answer, charges nothing and writes no second row', async () => {
    const first = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k1' })
    const again = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k1' })
    expect(again.replayed).toBe(true)
    expect(again.transactionId).toBe(first.transactionId)
    expect(again.totalCost).toBe(99)
    expect(again.beansCredited).toBe(51)

    expect(sender().diamonds).toBe(4901)
    expect(receiver().beans).toBe(91)
    expect(receiver().totalGiftsReceived).toBe(3)
    expect(db.count('giftTransactions')).toBe(1)
    expect(db.all(`users/${S}/diamondTransactions`).length).toBe(1)
    expect(db.all(`users/${R}/beanTransactions`).length).toBe(1)
    expect(db.count('platformRevenue')).toBe(1)
    expect(db.count('giftEvents')).toBe(1)
  })

  test('a new key is a new gift: charged again', async () => {
    await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k1' })
    const second = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'k2' })
    expect(second.replayed).toBe(false)
    expect(sender().diamonds).toBe(5000 - 2 * 99)
    expect(receiver().beans).toBe(40 + 2 * 51)
    expect(db.count('giftTransactions')).toBe(2)
  })
})

describe('where the receiver share comes from', () => {
  test('the gift\'s earningRate wins; without one, the category rate in appConfig/economy; without that, 50', async () => {
    db.seed('gifts/plain', { name: 'Plain', category: 'normal', diamondCost: 15, isActive: true })
    db.seed('gifts/gem', { name: 'Gem', category: 'exclusive', diamondCost: 15, isActive: true })

    // No economy document: the default 50. 15 x 50 / 100 = 7.5 -> 7.
    let r = await send({ giftId: 'plain', receiverUid: R, quantity: 1, idempotencyKey: 'p1' })
    expect([r.receiverPct, r.beansCredited]).toEqual([50, 7])

    db.seed('appConfig/economy', {
      giftRates: { normalReceiverPct: 45, exclusiveReceiverPctMin: 50, exclusiveReceiverPctMax: 55 },
    })
    // The category rate: 15 x 45 / 100 = 6.75 -> 6.
    r = await send({ giftId: 'plain', receiverUid: R, quantity: 1, idempotencyKey: 'p2' })
    expect([r.receiverPct, r.beansCredited]).toEqual([45, 6])
    // An exclusive gift takes the floor of the band's midpoint: (50 + 55) / 2 -> 52; 15 x 52 / 100 = 7.8 -> 7.
    r = await send({ giftId: 'gem', receiverUid: R, quantity: 1, idempotencyKey: 'p3' })
    expect([r.receiverPct, r.beansCredited]).toEqual([52, 7])
    // A gift with its own rate ignores the category rate: 99 x 52 / 100 -> 51.
    r = await send({ giftId: 'crown', receiverUid: R, quantity: 3, idempotencyKey: 'p4' })
    expect([r.receiverPct, r.beansCredited]).toEqual([52, 51])
  })
})

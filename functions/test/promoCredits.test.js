/**
 * B2c (3 Nov 2026) — daily rewards and free call cards reach the finance record, and cards finally work.
 *
 * The defects:
 *   1. `claimDailyReward` credited diamonds and free call cards into the user's own wallet and history only;
 *      nothing the CRM reports read ever saw them, so Zipper's promotional give-away was missing from every
 *      finance figure ("daily rewards are not updating CRM numbers").
 *   2. Free call cards (`videoCards`) were granted for months and no call ever used one.
 *
 * Now:
 *   * every claim writes `promoCredits/daily_{uid}_{date}` in the same transaction, naming its deterministic
 *     history row `daily_{date}`; a second claim the same day writes nothing;
 *   * one card pays the FIRST minute of a paid call: the payer is not debited for it and loses one card, the
 *     earner is paid for it as for any minute, and `promoCredits/card_{callId}` records Zipper's cost;
 *   * a payer holding a card may ring and be picked up with an empty wallet — and the call ends at the first
 *     boundary they cannot pay, as any call does;
 *   * the settlement's revenue row carries the card value; a call the card paid for entirely writes none (the
 *     reconciliation treats a call with nothing charged as unbilled, by design);
 *   * a free call (rate 0) never spends a card.
 *
 * REAL: lib/wallet.js and lib/calls.js as deployed, over the in-memory Firestore.
 *
 * Run:  node --test test/promoCredits.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
const W = require('../lib/wallet')
const calls = require('../lib/calls')

const PAYER = 'PAYER'
const EARNER = 'EARNER'
const CALL = 'CALL1'
const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000001' })
const run = (fn, uid, data = {}) => fn.run({ data: { callId: CALL, ...data }, auth: { uid, token: token() } })
const accept = (uid = EARNER) => run(calls.acceptCall, uid)
const tick = (uid = PAYER) => run(calls.tickCall, uid)
const end = (uid = PAYER) => run(calls.endCall, uid, { reason: 'user_ended' })
const ago = (sec) => Timestamp.fromMillis(Date.now() - sec * 1000)
async function refusal(p) { try { await p } catch (e) { return e } return null }

const RATE = 60   // diamonds a minute; the earner keeps 50%

function seedRinging(extra = {}) {
  db.seed(`calls/${CALL}`, {
    callerId: PAYER, receiverId: EARNER, earner: 'receiver', status: 'ringing',
    perMinRateDiamonds: RATE, receiverPct: 50, startedAt: null,
    tickIndex: 0, billingUnit: 'minute', billedThroughMs: null, diamondsCharged: 0, beansCredited: 0,
    createdAt: ago(5), ...extra,
  })
}
const payer = () => db.read(`users/${PAYER}`)
const earner = () => db.read(`users/${EARNER}`)
const callDoc = () => db.read(`calls/${CALL}`)
const promo = (id) => db.read(`promoCredits/${id}`)

describe('daily rewards are recorded where finance can see them', () => {
  beforeEach(() => {
    db._docs.clear()
    db.seed('users/U', { name: 'u', diamonds: 10 })
    db.seed('appConfig/dailyRewards', { schedule: [{ day: 1, diamonds: 50, callCards: 2 }] })
  })

  test('one claim → one promoCredits record naming its deterministic history row', async () => {
    const r = await W.claimDailyReward.run({}, { auth: { uid: 'U', token: token() } })
    expect(r).toEqual({ day: 1, diamonds: 50, videoCards: 2 })
    const docs = db.all('promoCredits')
    expect(docs.length).toBe(1)
    const p = docs[0]
    expect(p.kind).toBe('daily_reward')
    expect(p.uid).toBe('U')
    expect(p.diamonds).toBe(50)
    expect(p.videoCards).toBe(2)
    expect(p.day).toBe(1)
    expect(typeof p.dateKey).toBe('string')
    const row = db.read(p.historyRow)
    expect(row.reason).toBe('daily_reward')
    expect(row.amount).toBe(50)
    expect(row.funding).toBe('promotional')
    expect(db.read('users/U').diamonds).toBe(60)
    expect(db.read('users/U').videoCards).toBe(2)
  })

  test('a second claim the same day is refused and records nothing more', async () => {
    await W.claimDailyReward.run({}, { auth: { uid: 'U', token: token() } })
    const e = await refusal(W.claimDailyReward.run({}, { auth: { uid: 'U', token: token() } }))
    expect(e && e.code).toBe('already-exists')
    expect(db.all('promoCredits').length).toBe(1)
    expect(db.count('users/U/diamondTransactions')).toBe(1)
  })
})

describe('a free call card pays the first minute', () => {
  beforeEach(() => {
    db._docs.clear()
    db.seed(`users/${EARNER}`, { name: 'earner', beans: 0, isHost: true })
  })

  test('hasFreeCallCard: one or more cards on a paid call; never on a free call', () => {
    expect(calls.hasFreeCallCard(1, 60)).toBe(true)
    expect(calls.hasFreeCallCard(3, 60)).toBe(true)
    expect(calls.hasFreeCallCard(0, 60)).toBe(false)
    expect(calls.hasFreeCallCard(undefined, 60)).toBe(false)
    expect(calls.hasFreeCallCard('2', 60)).toBe(true)
    expect(calls.hasFreeCallCard(5, 0)).toBe(false)
  })

  test('an empty wallet with a card: picked up; the payer pays 0 and loses the card; the host is paid; Zipper\'s cost recorded', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 0, videoCards: 1 })
    seedRinging()
    const r = await accept()
    expect(r.status).toBe('connected')
    expect(r.charged).toBe(0)
    expect(r.beans).toBe(30)
    expect(payer().diamonds).toBe(0)
    expect(payer().videoCards).toBe(0)
    expect(earner().beans).toBe(30)
    expect(callDoc().cardMinutes).toBe(1)
    expect(callDoc().cardDiamonds).toBe(RATE)
    expect(callDoc().diamondsCharged).toBe(0)
    expect(callDoc().beansCredited).toBe(30)
    const card = promo(`card_${CALL}`)
    expect(card.kind).toBe('free_call_card_redeemed')
    expect(card.uid).toBe(PAYER)
    expect(card.hostUid).toBe(EARNER)
    expect(card.minutes).toBe(1)
    expect(card.diamondValue).toBe(RATE)
    expect(card.beansCredited).toBe(30)
    const row = db.read(`users/${PAYER}/diamondTransactions/call_${CALL}`)
    expect(row.amount).toBe(0)
    expect(row.freeCardMinutes).toBe(1)
    expect(db.read(`users/${EARNER}/beanTransactions/call_${CALL}`).amount).toBe(30)
  })

  test('…and the call ends at the boundary of the first minute the payer cannot pay; nothing to platformRevenue', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 0, videoCards: 1 })
    seedRinging()
    await accept()
    // 70 s in: minute 2 has started and cannot be paid.
    db.seed(`calls/${CALL}`, { ...callDoc(), startedAt: ago(70), lastTickAt: ago(5) })
    const t = await tick()
    expect(t.endNow).toBe(true)
    await end()
    const hist = db.read(`callHistory/${CALL}`)
    expect(hist.diamondsCharged).toBe(0)
    expect(hist.beansCredited).toBe(30)
    expect(hist.cardMinutes).toBe(1)
    expect(db.all('platformRevenue').length).toBe(0)
    expect(payer().diamonds).toBe(0)
  })

  test('a card and a wallet: minute 1 by card, minute 2 paid; the revenue row shows both', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 500, videoCards: 2 })
    seedRinging()
    await accept()
    expect(payer().diamonds).toBe(500)
    expect(payer().videoCards).toBe(1)          // ONE card per call
    db.seed(`calls/${CALL}`, { ...callDoc(), startedAt: ago(70), lastTickAt: ago(5) })
    await tick()
    expect(payer().diamonds).toBe(500 - RATE)
    expect(payer().videoCards).toBe(1)          // the second minute did not take another card
    await end()
    const rev = db.all('platformRevenue')
    expect(rev.length).toBe(1)
    expect(rev[0].grossDiamonds).toBe(RATE)     // what the payer paid
    expect(rev[0].payoutBeans).toBe(60)         // the host was paid for both minutes
    expect(rev[0].promoDiamonds).toBe(RATE)     // one minute was Zipper's
    expect(rev[0].platformCut).toBe(RATE - 60)
    expect(earner().beans).toBe(60)
  })

  test('no card and no diamonds: refused exactly as before; no card spent', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 10, videoCards: 0 })
    seedRinging()
    const e = await refusal(accept())
    expect(e && e.code).toBe('failed-precondition')
    expect(callDoc().status).toBe('declined')
    expect(db.all('promoCredits').length).toBe(0)
  })

  test('a free call never spends a card', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 0, videoCards: 3 })
    seedRinging({ perMinRateDiamonds: 0 })
    await accept()
    expect(payer().videoCards).toBe(3)
    expect(db.all('promoCredits').length).toBe(0)
  })

  test('a double-tap on Accept spends one card, once', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 0, videoCards: 2 })
    seedRinging()
    await accept()
    const again = await accept()
    expect(again.alreadyConnected).toBe(true)
    expect(payer().videoCards).toBe(1)
    expect(earner().beans).toBe(30)
  })
})

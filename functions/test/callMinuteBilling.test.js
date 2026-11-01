/**
 * Per-minute call billing (M-8 / M-19 follow-up) — the SHIPPED handlers run
 * against the in-memory Firestore.
 *
 * The rule under test (functions/src/calls.ts header):
 *
 *   * connect   `acceptCall` charges the first full minute in the transaction
 *               that activates the call (`tickIndex = 1`, `billedThroughMs =
 *               startedAt + 60 000`); a payer who cannot afford one minute is
 *               refused and the ringing call is closed, nothing charged;
 *   * tick      `floor(elapsedSec / 60) + 1` minutes are owed — the started
 *               minute counts — and `minutesDue - tickIndex` whole minutes are
 *               charged, capped by the balance; a minute that cannot be paid
 *               for ends the call at that boundary (`insufficient_diamonds`)
 *               and the minutes already charged stay charged; a replayed tick
 *               charges nothing; an EARNER tick charges nothing but refreshes
 *               `lastTickAt`;
 *   * end       `endCall` bills through the minute in progress at the end
 *               instant (`max(1, ceil(elapsedSec / 60))`), never a partial
 *               minute; the watchdog ends a call whose last tick from either
 *               side is older than 120 s and bills through the minute
 *               containing that last tick.
 *
 * Run:  node --test test/callMinuteBilling.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
const calls = require('../lib/calls')

const PAYER = 'PAYER'
const EARNER = 'EARNER'
const CALL = 'CALL1'
const token = () => ({ auth_time: 2000, firebase: { sign_in_provider: 'phone' } })
const run = (fn, uid, data = {}) => fn.run({ data: { callId: CALL, ...data }, auth: { uid, token: token() } })
const tick = (uid, data = {}) => run(calls.tickCall, uid, data)
const end = (uid, reason = 'user_ended') => run(calls.endCall, uid, { reason })
const accept = (uid = EARNER) => run(calls.acceptCall, uid)
const ago = (sec) => Timestamp.fromMillis(Date.now() - sec * 1000)
async function refusal(p) { try { await p } catch (e) { return e } return null }

// 60 diamonds a minute, the receiver earns 50%; the caller pays.
const RATE = 60
function seedConnected({ startedSecAgo, lastTickSecAgo = startedSecAgo, tickIndex = 1, status = 'connected', extra = {} }) {
  db.seed(`calls/${CALL}`, {
    callerId: PAYER, receiverId: EARNER, earner: 'receiver', status,
    perMinRateDiamonds: RATE, receiverPct: 50,
    startedAt: ago(startedSecAgo), lastTickAt: ago(lastTickSecAgo),
    tickIndex, billingUnit: 'minute',
    billedThroughMs: Date.now() - startedSecAgo * 1000 + tickIndex * 60_000,
    diamondsCharged: tickIndex * RATE, beansCredited: tickIndex * RATE / 2,
    ...extra,
  })
  // The rows acceptCall opens with the first minute (the balances above were
  // seeded already net of them).
  if (tickIndex > 0) {
    db.seed(`users/${PAYER}/diamondTransactions/call_${CALL}`, {
      type: 'debit', amount: tickIndex * RATE, reason: 'video_call', callId: CALL,
      minutesBilled: tickIndex, timestamp: ago(startedSecAgo),
    })
    db.seed(`users/${EARNER}/beanTransactions/call_${CALL}`, {
      type: 'credit', amount: tickIndex * RATE / 2, reason: 'video_call', callId: CALL,
      minutesBilled: tickIndex, timestamp: ago(startedSecAgo),
    })
  }
}
function seedRinging(extra = {}) {
  db.seed(`calls/${CALL}`, {
    callerId: PAYER, receiverId: EARNER, earner: 'receiver', status: 'ringing',
    perMinRateDiamonds: RATE, receiverPct: 50, startedAt: null,
    tickIndex: 0, billingUnit: 'minute', billedThroughMs: null, diamondsCharged: 0, beansCredited: 0,
    createdAt: ago(5),
    ...extra,
  })
}
const diamonds = () => db.read(`users/${PAYER}`).diamonds
const beans = () => db.read(`users/${EARNER}`).beans
const callDoc = () => db.read(`calls/${CALL}`)
const payerLedger = () => db.read(`users/${PAYER}/diamondTransactions/call_${CALL}`)
const earnerLedger = () => db.read(`users/${EARNER}/beanTransactions/call_${CALL}`)

beforeEach(() => {
  db._docs.clear()
  db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 1000 })
  db.seed(`users/${EARNER}`, { name: 'earner', beans: 0, isHost: true })
})

// ══ The pure boundary arithmetic ═════════════════════════════════════════════

describe('the minute arithmetic at the boundaries', () => {
  test('a tick owes the started minute: 59 s → 1, 60 s → 2, 61 s → 2', () => {
    expect(calls.minutesStartedBy(59_000)).toBe(1)
    expect(calls.minutesStartedBy(60_000)).toBe(2)
    expect(calls.minutesStartedBy(61_000)).toBe(2)
    expect(calls.minutesStartedBy(0)).toBe(1)
    expect(calls.minutesStartedBy(-5_000)).toBe(1)   // a clock that went backwards still owes the first minute
  })
  test('an end owes through the minute in progress: 59 s → 1, 60 s → 1, 61 s → 2, 0 s → 1', () => {
    expect(calls.minutesTouchedBy(59_000)).toBe(1)
    expect(calls.minutesTouchedBy(60_000)).toBe(1)
    expect(calls.minutesTouchedBy(61_000)).toBe(2)
    expect(calls.minutesTouchedBy(0)).toBe(1)
    expect(calls.minutesTouchedBy(119_999)).toBe(2)
    expect(calls.minutesTouchedBy(120_001)).toBe(3)
  })
})

// ══ acceptCall: the first minute is charged where the call becomes active ═════

describe('acceptCall charges the first full minute in the activating transaction', () => {
  test('connect: payer −60, earner +30, tickIndex 1, billedThroughMs = startedAt + 60 s, ledger rows opened', async () => {
    seedRinging()
    const r = await accept()
    expect(r.status).toBe('connected')
    expect(r.alreadyConnected).toBe(false)
    expect(r.minutesBilled).toBe(1)
    expect(r.charged).toBe(RATE)
    expect(r.beans).toBe(30)
    expect(r.billedThroughMs).toBe(r.startedAtMs + 60_000)

    const c = callDoc()
    expect(c.status).toBe('connected')
    expect(c.tickIndex).toBe(1)
    expect(c.billingUnit).toBe('minute')
    expect(c.startedAt.toMillis()).toBe(r.startedAtMs)
    expect(c.billedThroughMs).toBe(r.startedAtMs + 60_000)
    expect(c.diamondsCharged).toBe(RATE)
    expect(c.beansCredited).toBe(30)
    expect(c.lastTickAt.toMillis()).toBe(r.startedAtMs)

    expect(diamonds()).toBe(940)
    expect(beans()).toBe(30)
    expect(db.read(`users/${EARNER}`).hostCallEarnings).toBe(30)
    expect(db.read(`users/${EARNER}`).totalBeansEarned).toBe(30)

    const pl = payerLedger()
    expect(pl.type).toBe('debit')
    expect(pl.amount).toBe(RATE)
    expect(pl.balanceAfter).toBe(940)
    expect(pl.reason).toBe('video_call')
    expect(pl.callId).toBe(CALL)
    expect(pl.minutesBilled).toBe(1)
    expect(pl.timestamp.toMillis()).toBe(r.startedAtMs)
    const el = earnerLedger()
    expect(el.type).toBe('credit')
    expect(el.amount).toBe(30)
    expect(el.balanceAfter).toBe(30)

    // The week bucket and the day's host stats commit with the credit.
    const weeks = db.all(`users/${EARNER}/weeklyEarnings`)
    expect(weeks.length).toBe(1)
    expect(weeks[0].beans).toBe(30)
    expect(weeks[0].callBeans).toBe(30)
    const days = db.all(`users/${EARNER}/dailyStats`)
    expect(days.length).toBe(1)
    expect(days[0].callSeconds).toBe(60)
    expect(days[0].beans).toBe(30)
  })

  test('a double-tap on Accept does not charge a second minute', async () => {
    seedRinging()
    const first = await accept()
    const again = await accept()
    expect(again.alreadyConnected).toBe(true)
    expect(again.minutesBilled).toBe(1)
    expect(again.billedThroughMs).toBe(first.billedThroughMs)
    expect(diamonds()).toBe(940)
    expect(callDoc().tickIndex).toBe(1)
  })

  test('a payer who cannot afford one minute is refused as startCall refuses, and the ring is closed with nothing charged', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: RATE - 1 })
    seedRinging()
    const e = await refusal(accept())
    expect(e && e.code).toBe('failed-precondition')
    expect(String(e.message).includes('does not have enough diamonds')).toBe(true)
    expect(diamonds()).toBe(RATE - 1)
    expect(beans()).toBe(0)
    const c = callDoc()
    expect(c.status).toBe('declined')
    expect(c.endReason).toBe('insufficient_diamonds')
    expect(c.tickIndex).toBe(0)
    const h = db.read(`callHistory/${CALL}`)
    expect(h.status).toBe('declined')
    expect(h.endReason).toBe('insufficient_diamonds')
    expect(h.diamondsCharged).toBe(0)
    expect(payerLedger()).toBe(undefined)
  })

  test('when the RECEIVER is the payer the refusal is addressed to them', async () => {
    db.seed(`users/${EARNER}`, { name: 'host-caller', beans: 0, isHost: true })
    db.seed(`users/${PAYER}`, { name: 'user-receiver', diamonds: 10 })
    // The host rang the user: the user (receiver) pays, the host (caller) earns.
    seedRinging({ callerId: EARNER, receiverId: PAYER, earner: 'caller' })
    const e = await refusal(accept(PAYER))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe(`You need ${RATE} diamonds for one minute. You have 10.`)
    expect(callDoc().status).toBe('declined')
  })

  test('exactly one minute in the wallet is enough', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: RATE })
    seedRinging()
    const r = await accept()
    expect(r.status).toBe('connected')
    expect(diamonds()).toBe(0)
  })

  test('a payer banned between ring and pick-up: refused, closed, nothing charged', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 1000, isBanned: true, accountState: 'banned' })
    seedRinging()
    const e = await refusal(accept())
    expect(e && e.code).toBe('permission-denied')
    expect(diamonds()).toBe(1000)
    expect(callDoc().status).toBe('declined')
    expect(callDoc().endReason).toBe('party_restricted')
  })

  test('only the receiver may accept, and only a ringing call', async () => {
    seedRinging()
    expect((await refusal(accept(PAYER))).code).toBe('permission-denied')
    seedRinging({ status: 'declined' })
    expect((await refusal(accept())).code).toBe('failed-precondition')
    expect(diamonds()).toBe(1000)
  })

  test('end to end: startCall prices the minute from the host record, acceptCall charges it, a tick at 61 s charges the second', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', gender: 'male', diamonds: 2500 })
    db.seed(`users/${EARNER}`, { name: 'host', gender: 'female', beans: 0, isHost: true, isVerifiedHost: true, callRateBeans: 500 })
    const started = await calls.startCall.run({ data: { peerUid: EARNER, idempotencyKey: 'k1' }, auth: { uid: PAYER, token: token() } })
    expect(started.perMinRateDiamonds).toBe(1000)   // 500 beans at 50% → 1,000 diamonds a minute
    const ringing = db.read(`calls/${started.callId}`)
    expect(ringing.status).toBe('ringing')
    expect(ringing.tickIndex).toBe(0)
    expect(ringing.billingUnit).toBe('minute')

    const r = await calls.acceptCall.run({ data: { callId: started.callId }, auth: { uid: EARNER, token: token() } })
    expect(r.charged).toBe(1000)
    expect(r.beans).toBe(500)
    expect(diamonds()).toBe(1500)
    expect(beans()).toBe(500)

    // 61 s later the payer ticks: minute 2 has started.
    db.seed(`calls/${started.callId}`, { ...db.read(`calls/${started.callId}`), startedAt: ago(61) })
    const t = await calls.tickCall.run({ data: { callId: started.callId }, auth: { uid: PAYER, token: token() } })
    expect(t.charged).toBe(1000)
    expect(t.tickIndex).toBe(2)
    expect(t.affordableMinutes).toBe(0)
    expect(diamonds()).toBe(500)
    expect(beans()).toBe(1000)
  })
})

// ══ tickCall: whole minutes, the started minute counts ════════════════════════

describe('tickCall bills whole minutes at the boundary', () => {
  test('59 s in: the first minute (paid at connect) is all that is owed — nothing charged', async () => {
    seedConnected({ startedSecAgo: 59 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(0)
    expect(r.endNow).toBe(false)
    expect(r.tickIndex).toBe(1)
    expect(r.minutesBilled).toBe(1)
    expect(diamonds()).toBe(1000)
    expect(callDoc().tickIndex).toBe(1)
  })

  test('60 s in: minute 2 has started and is charged in full', async () => {
    seedConnected({ startedSecAgo: 60 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(RATE)
    expect(r.beans).toBe(30)
    expect(r.endNow).toBe(false)
    expect(r.tickIndex).toBe(2)
    expect(r.minutesBilled).toBe(2)
    expect(r.billedThroughMs).toBe(callDoc().startedAt.toMillis() + 120_000)
    expect(r.nextChargeAtMs).toBe(r.billedThroughMs)
    expect(diamonds()).toBe(940)
    expect(beans()).toBe(30)
    expect(callDoc().tickIndex).toBe(2)
    expect(callDoc().billedThroughMs).toBe(r.billedThroughMs)
  })

  test('61 s in: the same single minute, not two and not a fraction', async () => {
    seedConnected({ startedSecAgo: 61 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(RATE)
    expect(r.tickIndex).toBe(2)
    expect(diamonds()).toBe(940)
  })

  test('a replay of the same tick charges nothing (and still refreshes the evidence of life)', async () => {
    seedConnected({ startedSecAgo: 61, lastTickSecAgo: 61 })
    const first = await tick(PAYER)
    expect(first.charged).toBe(RATE)
    const before = callDoc().lastTickAt.toMillis()
    const replay = await tick(PAYER)
    expect(replay.charged).toBe(0)
    expect(replay.endNow).toBe(false)
    expect(replay.tickIndex).toBe(2)
    expect(diamonds()).toBe(940)
    expect(callDoc().tickIndex).toBe(2)
    expect(callDoc().lastTickAt.toMillis()).toBeGreaterThanOrEqual(before)
  })

  test('a tick that arrives late charges every whole minute that has started since the last one', async () => {
    seedConnected({ startedSecAgo: 185 })        // 3 min 5 s: minutes 2, 3 and 4 have started
    const r = await tick(PAYER)
    expect(r.charged).toBe(3 * RATE)
    expect(r.tickIndex).toBe(4)
    expect(diamonds()).toBe(1000 - 180)
    expect(beans()).toBe(90)
    expect(payerLedger().amount).toBe(4 * RATE)   // the row carries the whole call so far
    expect(payerLedger().balanceAfter).toBe(820)
  })

  test('the payer\'s tick reports how many more minutes the balance covers', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 150 })
    seedConnected({ startedSecAgo: 61 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(RATE)
    expect(r.affordableMinutes).toBe(1)          // 90 left covers one more minute
  })

  test('an EARNER tick charges nothing and does not advance tickIndex, but refreshes lastTickAt', async () => {
    seedConnected({ startedSecAgo: 125, lastTickSecAgo: 100 })
    const before = callDoc().lastTickAt.toMillis()
    const r = await tick(EARNER)
    expect(r.charged).toBe(0)
    expect(r.role).toBe('earner')
    expect(r.tickIndex).toBe(1)
    expect(diamonds()).toBe(1000)
    expect(beans()).toBe(0)
    expect(callDoc().tickIndex).toBe(1)
    expect(callDoc().lastTickAt.toMillis()).toBeGreaterThan(before)
    expect(callDoc().lastEarnerTickAt.toMillis()).toBeGreaterThan(before)
  })

  test('a stranger cannot tick', async () => {
    seedConnected({ startedSecAgo: 61 })
    expect((await refusal(tick('NOBODY'))).code).toBe('permission-denied')
    expect(diamonds()).toBe(1000)
  })
})

describe('insufficient balance at a boundary ends the call there', () => {
  test('the next minute cannot be afforded: nothing charged, endNow, insufficient_diamonds — the first minute stays paid', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: RATE - 1 })   // minute 1 was paid at connect
    seedConnected({ startedSecAgo: 61 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(0)
    expect(r.endNow).toBe(true)
    expect(r.status).toBe('ending')
    expect(r.endReason).toBe('insufficient_diamonds')
    expect(r.tickIndex).toBe(1)
    expect(diamonds()).toBe(RATE - 1)
    const c = callDoc()
    expect(c.status).toBe('ending')
    expect(c.endReason).toBe('insufficient_diamonds')
    expect(c.tickIndex).toBe(1)
    expect(typeof c.endingAt.toMillis).toBe('function')

    // Settling it afterwards charges nothing more, whatever reason the client sends.
    const s = await end(PAYER, 'user_ended')
    expect(s.diamondsCharged).toBe(RATE)
    expect(s.minutesBilled).toBe(1)
    expect(s.endReason).toBe('insufficient_diamonds')
    expect(diamonds()).toBe(RATE - 1)
    expect(callDoc().status).toBe('ended')
    expect(callDoc().endReason).toBe('insufficient_diamonds')
  })

  test('three minutes owed, one affordable: that one is charged and the call ends at its boundary', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: RATE + 10 })
    seedConnected({ startedSecAgo: 185 })        // minutes 2, 3, 4 started
    const r = await tick(PAYER)
    expect(r.charged).toBe(RATE)
    expect(r.endNow).toBe(true)
    expect(r.endReason).toBe('insufficient_diamonds')
    expect(r.tickIndex).toBe(2)
    expect(diamonds()).toBe(10)
    expect(beans()).toBe(30)
    expect(callDoc().status).toBe('ending')
    expect(callDoc().tickIndex).toBe(2)
  })

  test('a tick after the server has decided to end says so and moves nothing', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 5 })
    seedConnected({ startedSecAgo: 61 })
    await tick(PAYER)
    const again = await tick(PAYER)
    expect(again.endNow).toBe(true)
    expect(again.status).toBe('ending')
    expect(again.endReason).toBe('insufficient_diamonds')
    expect(again.charged).toBe(0)
    expect(diamonds()).toBe(5)
  })
})

// ══ endCall: through the minute in progress, never partial ════════════════════

describe('endCall bills through the minute in progress at the end instant', () => {
  test('a mid-minute end pays the started minute: 90 s → 2 minutes', async () => {
    seedConnected({ startedSecAgo: 90 })
    const r = await end(PAYER, 'caller_ended')
    expect(r.alreadyEnded).toBe(false)
    expect(r.minutesBilled).toBe(2)
    expect(r.diamondsCharged).toBe(2 * RATE)
    expect(r.beansCredited).toBe(60)
    expect(r.durationSeconds).toBe(90)
    expect(diamonds()).toBe(940)
    expect(beans()).toBe(30)
    const c = callDoc()
    expect(c.status).toBe('ended')
    expect(c.endReason).toBe('caller_ended')
    expect(c.tickIndex).toBe(2)
    expect(c.diamondsCharged).toBe(2 * RATE)
    expect(c.billedThroughMs).toBe(c.startedAt.toMillis() + 120_000)
    // The ledger rows carry the final duration and the running total.
    expect(payerLedger().amount).toBe(2 * RATE)
    expect(payerLedger().durationSeconds).toBe(90)
    expect(payerLedger().reasonLabel).toBe('Video call — 1m 30s')
    expect(earnerLedger().amount).toBe(60)
    // History and revenue rows.
    const h = db.read(`callHistory/${CALL}`)
    expect(h.diamondsCharged).toBe(2 * RATE)
    expect(h.beansEarned).toBe(60)
    expect(h.platformCut).toBe(60)
    const rev = db.all('platformRevenue')
    expect(rev.length).toBe(1)
    expect(rev[0].type).toBe('call')
    expect(rev[0].grossDiamonds).toBe(2 * RATE)
    expect(rev[0].minutesBilled).toBe(2)
    // Counted as one call taken, for the host's day.
    const days = db.all(`users/${EARNER}/dailyStats`)
    expect(days[0].calls).toBe(1)
    expect(days[0].callSeconds).toBe(60)      // only the minute charged here; the first was accrued at connect
  })

  test('59.5 s → the first minute only (already paid): nothing more charged', async () => {
    seedConnected({ startedSecAgo: 59.5 })
    const r = await end(EARNER, 'receiver_ended')
    expect(r.minutesBilled).toBe(1)
    expect(r.diamondsCharged).toBe(RATE)
    expect(diamonds()).toBe(1000)
    expect(callDoc().status).toBe('ended')
  })

  test('60.5 s → the second minute has started and is paid in full', async () => {
    seedConnected({ startedSecAgo: 60.5 })
    const r = await end(PAYER)
    expect(r.minutesBilled).toBe(2)
    expect(r.diamondsCharged).toBe(2 * RATE)
    expect(diamonds()).toBe(940)
  })

  test('the balance caps the final charge: it never goes negative', async () => {
    db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 70 })
    seedConnected({ startedSecAgo: 200 })      // minutes 2, 3, 4 owed, one affordable
    const r = await end(PAYER)
    expect(r.diamondsCharged).toBe(2 * RATE)
    expect(diamonds()).toBe(10)
  })

  test('ending twice settles once', async () => {
    seedConnected({ startedSecAgo: 90 })
    const first = await end(PAYER)
    const again = await end(EARNER)
    expect(again.alreadyEnded).toBe(true)
    expect(again.diamondsCharged).toBe(first.diamondsCharged)
    expect(again.minutesBilled).toBe(2)
    expect(diamonds()).toBe(940)
    expect(db.all('platformRevenue').length).toBe(1)
  })

  test('a call that never connected settles with nothing charged', async () => {
    seedRinging()
    const r = await end(PAYER, 'caller_cancelled')
    expect(r.diamondsCharged).toBe(0)
    expect(r.minutesBilled).toBe(0)
    expect(diamonds()).toBe(1000)
    expect(callDoc().status).toBe('ended')
    expect(db.all('platformRevenue').length).toBe(0)
  })

  test('a call connected under the old ten-second rule finishes under this one, with its ledger row written in full', async () => {
    // 7 ticks of 10 s were charged (70 diamonds) and no ledger row was written.
    db.seed(`calls/${CALL}`, {
      callerId: PAYER, receiverId: EARNER, earner: 'receiver', status: 'connected',
      perMinRateDiamonds: RATE, receiverPct: 50,
      startedAt: ago(95), lastTickAt: ago(20),
      tickIndex: 7, diamondsCharged: 70, beansCredited: 35,
    })
    const r = await end(PAYER)
    // ceil(7 / 6) = 2 minutes treated as paid; 95 s touches minute 2: nothing more.
    expect(r.minutesBilled).toBe(2)
    expect(r.diamondsCharged).toBe(70)
    expect(diamonds()).toBe(1000)
    expect(payerLedger().amount).toBe(70)
    expect(earnerLedger().amount).toBe(35)
    expect(callDoc().billingUnit).toBe('minute')
  })
})

// ══ The watchdog ═════════════════════════════════════════════════════════════

describe('the watchdog ends a silent call and bills through the last evidence of activity', () => {
  const sweep = () => calls.sweepStaleCalls.run({}, {})

  test('last tick 150 s ago (from the earner), connected 400 s ago: ended, billed through the minute containing that tick', async () => {
    seedConnected({ startedSecAgo: 400, lastTickSecAgo: 150 })
    await sweep()
    const c = callDoc()
    expect(c.status).toBe('ended')
    expect(c.endReason).toBe('watchdog_timeout')
    // 250 s of evidenced call → ceil(250 / 60) = 5 minutes; 1 was paid at connect.
    expect(c.tickIndex).toBe(5)
    expect(c.diamondsCharged).toBe(5 * RATE)
    expect(c.durationSeconds).toBe(250)
    expect(diamonds()).toBe(1000 - 4 * RATE)
    expect(beans()).toBe(120)
    expect(db.read(`callHistory/${CALL}`).endReason).toBe('watchdog_timeout')
  })

  test('the two minutes of silence are not billed: last tick 130 s after connect, swept 300 s after → 3 minutes, not 5', async () => {
    seedConnected({ startedSecAgo: 300, lastTickSecAgo: 170 })
    await sweep()
    expect(callDoc().tickIndex).toBe(3)          // ceil(130 / 60)
    expect(diamonds()).toBe(1000 - 2 * RATE)
  })

  test('a call ticked within the last two minutes is left alone', async () => {
    seedConnected({ startedSecAgo: 300, lastTickSecAgo: 100 })
    await sweep()
    expect(callDoc().status).toBe('connected')
    expect(diamonds()).toBe(1000)
  })

  test('an earner tick keeps a silent payer on the clock: the earner\'s evidence is what the watchdog bills to', async () => {
    seedConnected({ startedSecAgo: 400, lastTickSecAgo: 400 })
    // The payer's device has gone; the earner ticks at 400 s → lastTickAt = now.
    await tick(EARNER)
    expect(diamonds()).toBe(1000)
    // Push the evidence back 125 s so the sweep sees a stale call that was alive at 275 s.
    db.seed(`calls/${CALL}`, { ...callDoc(), lastTickAt: ago(125) })
    await sweep()
    expect(callDoc().status).toBe('ended')
    expect(callDoc().tickIndex).toBe(5)          // ceil(275 / 60)
    expect(diamonds()).toBe(1000 - 4 * RATE)
  })

  test('a ring nobody answered expires with no money moved', async () => {
    seedRinging({ createdAt: ago(60) })
    await sweep()
    expect(callDoc().status).toBe('missed')
    expect(callDoc().endReason).toBe('no_answer')
    expect(diamonds()).toBe(1000)
    expect(db.read(`callHistory/${CALL}`).diamondsCharged).toBe(0)
  })
})

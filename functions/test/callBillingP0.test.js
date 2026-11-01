/**
 * P0-6 (FIN-1, FIN-2, FINANCE-016) — a call ends, and stops billing, when
 * either party may no longer be on it; and nobody but the server prices time.
 *
 * Before:
 *   * `tickCall` accepted a tick from EITHER participant and billed the payer
 *     for all elapsed time;
 *   * nothing checked restriction or the payer's sign-in, so a banned or
 *     displaced party stayed on a billed call;
 *   * `settleAndClose` (endCall and the watchdog) billed every whole tick from
 *     `startedAt` to NOW — two minutes of silence before the watchdog ran were
 *     charged at full rate.
 *
 * Now (the per-minute rule, see test/callMinuteBilling.test.js for the money):
 *   * an earner's tick moves nothing — it only refreshes `lastTickAt`;
 *   * the payer's tick ends the call — charging nothing more at that tick —
 *     when either party is restricted or the payer's sign-in predates the
 *     account cut-off or no longer holds the session, and the gate instant is
 *     stamped (`endingAt`);
 *   * settlement bills through the minute in progress at the END INSTANT: the
 *     gate instant for a gated end (never a later moment the client chose),
 *     the last tick from either side for the watchdog.
 *
 * Run:  node --test test/callBillingP0.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
const calls = require('../lib/calls')

const PAYER = 'PAYER'
const EARNER = 'EARNER'
const CALL = 'CALL1'
const token = (authTime = 2000) => ({ auth_time: authTime, firebase: { sign_in_provider: 'phone' } })
const tick = (uid, data = {}, tok = token()) => calls.tickCall.run({ data: { callId: CALL, ...data }, auth: { uid, token: tok } })
const end = (uid, reason = 'user_ended') => calls.endCall.run({ data: { callId: CALL, reason }, auth: { uid, token: token() } })
const ago = (sec) => Timestamp.fromMillis(Date.now() - sec * 1000)

// 60 diamonds a minute; the receiver earns, the caller pays. `tickIndex` is
// minutes already charged (the first was charged at connect).
function seedCall({ startedSecAgo, lastTickSecAgo, tickIndex = 1, status = 'connected', extra = {} }) {
  db.seed(`calls/${CALL}`, {
    callerId: PAYER, receiverId: EARNER, earner: 'receiver', status,
    perMinRateDiamonds: 60, receiverPct: 50, billingUnit: 'minute',
    startedAt: ago(startedSecAgo), lastTickAt: ago(lastTickSecAgo),
    tickIndex, diamondsCharged: tickIndex * 60, beansCredited: tickIndex * 30,
    ...extra,
  })
}
const diamonds = () => db.read(`users/${PAYER}`).diamonds
const callDoc = () => db.read(`calls/${CALL}`)

beforeEach(() => {
  db._docs.clear()
  db.seed(`users/${PAYER}`, { name: 'payer', diamonds: 1000 })
  db.seed(`users/${EARNER}`, { name: 'earner', beans: 0, isHost: false })
})

describe('only the payer is billed by a tick', () => {
  test('an EARNER tick charges nothing and advances nothing — it only refreshes lastTickAt', async () => {
    seedCall({ startedSecAgo: 95, lastTickSecAgo: 95 })
    const before = callDoc().lastTickAt.toMillis()
    const r = await tick(EARNER)
    expect(r.charged).toBe(0)
    expect(diamonds()).toBe(1000)
    expect(callDoc().tickIndex).toBe(1)
    expect(callDoc().lastTickAt.toMillis()).toBeGreaterThan(before)
  })
  test('the PAYER tick bills the whole minutes that have started (control)', async () => {
    seedCall({ startedSecAgo: 95, lastTickSecAgo: 5 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(60)                  // minute 2 started at 60 s
    expect(diamonds()).toBe(940)
    expect(callDoc().tickIndex).toBe(2)
  })
})

describe('the payer tick ends the call — and charges nothing at that tick — when the gate fails', () => {
  const cases = [
    ['the payer is banned', () => db.seed(`users/${PAYER}`, { diamonds: 1000, isBanned: true, accountState: 'banned' }), token(), {}, 'party_restricted'],
    ['the earner is suspended', () => db.seed(`users/${EARNER}`, { isSuspended: true, isBanned: true, accountState: 'suspended' }), token(), {}, 'party_restricted'],
    ['the payer is deleting the account', () => db.seed(`users/${PAYER}`, { diamonds: 1000, isDeleted: true, accountState: 'recovery_pending' }), token(), {}, 'party_restricted'],
    ['the payer sign-in predates the cut-off', () => db.seed(`users/${PAYER}`, { diamonds: 1000, credentialsValidAfter: 3000 }), token(2000), {}, 'session_displaced'],
    ['the payer presents a session that is no longer active', () => db.seed(`users/${PAYER}`, { diamonds: 1000, activeMobileSession: { sessionId: 'NEW-PHONE' } }), token(), { sessionId: 'OLD-PHONE' }, 'session_displaced'],
  ]
  for (const [label, arrange, tok, data, reason] of cases) {
    test(`${label} → endNow, nothing charged, reason ${reason}`, async () => {
      seedCall({ startedSecAgo: 95, lastTickSecAgo: 25 })
      arrange()
      const r = await tick(PAYER, data, tok)
      expect(r.endNow).toBe(true)
      expect(r.charged).toBe(0)
      expect(diamonds()).toBe(1000)
      expect(callDoc().status).toBe('ending')
      expect(callDoc().endReason).toBe(reason)
      expect(typeof callDoc().endingAt.toMillis).toBe('function')
    })
  }

  test('…and settling that call bills through the minute in progress AT THE GATE, keeping the server reason', async () => {
    seedCall({ startedSecAgo: 95, lastTickSecAgo: 85 })
    db.seed(`users/${EARNER}`, { isBanned: true, accountState: 'banned' })
    await tick(PAYER)                            // gate fires at 95 s: minute 2 is in progress
    const r = await end(PAYER, 'diamonds_exhausted')
    expect(r.diamondsCharged).toBe(120)         // minute 1 (connect) + minute 2 (in progress at the gate)
    expect(diamonds()).toBe(940)
    expect(callDoc().status).toBe('ended')
    expect(callDoc().endReason).toBe('party_restricted')
  })

  test('…and a client that calls endCall long after the gate cannot be billed past the gate instant', async () => {
    seedCall({ startedSecAgo: 95, lastTickSecAgo: 85 })
    db.seed(`users/${PAYER}`, { diamonds: 1000, credentialsValidAfter: 3000 })
    await tick(PAYER, {}, token(2000))          // gated at 95 s
    // The client only gets round to hanging up "four minutes later".
    db.seed(`calls/${CALL}`, { ...callDoc(), startedAt: ago(335), endingAt: ago(240) })
    const r = await end(PAYER)
    expect(r.minutesBilled).toBe(2)             // ceil(95 / 60), from the gate instant
    expect(diamonds()).toBe(940)
    expect(callDoc().endReason).toBe('session_displaced')
  })
})

describe('settlement bills to the last evidence of activity, never into the silence', () => {
  test('payer went silent 200 s ago, the earner hangs up now: the hang-up instant is the end instant', async () => {
    // 290 s, not 300: an exact minute boundary would flip to 6 the moment the clock
    // ticks past it during the test.
    seedCall({ startedSecAgo: 290, lastTickSecAgo: 200, tickIndex: 2 })
    const r = await end(EARNER, 'receiver_ended')
    expect(r.minutesBilled).toBe(5)             // ceil(290 / 60): a hang-up is a live decision by a party
    expect(r.diamondsCharged).toBe(300)
    expect(diamonds()).toBe(1000 - 180)
  })
  test('the watchdog, by contrast, bills only through the minute containing the last tick', async () => {
    seedCall({ startedSecAgo: 300, lastTickSecAgo: 200, tickIndex: 2 })
    await calls.sweepStaleCalls.run({}, {})
    expect(callDoc().status).toBe('ended')
    expect(callDoc().endReason).toBe('watchdog_timeout')
    expect(callDoc().tickIndex).toBe(2)         // ceil(100 / 60) = 2, both already paid
    expect(diamonds()).toBe(1000)
  })
  test('a payer ticking normally and hanging up is billed exactly the started minutes (control)', async () => {
    seedCall({ startedSecAgo: 125, lastTickSecAgo: 5, tickIndex: 2 })
    const r = await end(PAYER, 'caller_ended')
    expect(r.diamondsCharged).toBe(180)         // minute 3 in progress at 125 s
    expect(diamonds()).toBe(940)
  })
  test('the watchdog settles through the same function, at the last tick', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'calls.ts'), 'utf8')
    const sweep = src.slice(src.indexOf('export const sweepStaleCalls'))
    expect(sweep.includes("settleAndClose(doc.id, null, 'watchdog_timeout', { endAt: 'lastTick' })")).toBe(true)
    // No ten-second arithmetic survives: the constant is gone from the code
    // (the header may still mention it by name as history).
    expect(/const TICK_SECONDS|\bTICK_SECONDS\s*\*|\/\s*TICK_SECONDS/.test(src)).toBe(false)
  })
})

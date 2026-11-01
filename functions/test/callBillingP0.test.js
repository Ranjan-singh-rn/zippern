/**
 * P0-6 (FIN-1, FIN-2, FINANCE-016) — a call bills the payer only for time the
 * PAYER's device vouched for, and stops when either party may no longer be on it.
 *
 * Before:
 *   * `tickCall` accepted a tick from EITHER participant and billed the payer
 *     for all elapsed time, and every tick refreshed `lastTickAt` — so an earner
 *     that kept ticking after the payer's app had gone kept charging the payer
 *     and kept the watchdog away;
 *   * nothing checked restriction or the payer's sign-in, so a banned or
 *     displaced party stayed on a billed call;
 *   * `settleAndClose` (endCall and the watchdog) billed every whole tick from
 *     `startedAt` to NOW — two minutes of silence before the watchdog ran were
 *     charged at full rate.
 *
 * Now:
 *   * an earner's tick moves nothing and refreshes nothing;
 *   * the payer's tick ends the call — charging nothing more — when either
 *     party is restricted or the payer's sign-in predates the account cut-off or
 *     no longer holds the session;
 *   * settlement bills only up to the payer's last tick plus one tick of grace,
 *     and not even the grace when the call was ended by that gate.
 *
 * Run:  node --test test/callBillingP0.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')
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

// 60 diamonds a minute → 10 per 10-second tick; the receiver earns, the caller pays.
function seedCall({ startedSecAgo, lastTickSecAgo, tickIndex = 0, status = 'connected', extra = {} }) {
  db.seed(`calls/${CALL}`, {
    callerId: PAYER, receiverId: EARNER, earner: 'receiver', status,
    perMinRateDiamonds: 60, receiverPct: 50,
    startedAt: ago(startedSecAgo), lastTickAt: ago(lastTickSecAgo),
    tickIndex, diamondsCharged: tickIndex * 10, beansCredited: tickIndex * 5,
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

describe('only the payer ticks', () => {
  test('an EARNER tick charges nothing and does not refresh lastTickAt', async () => {
    seedCall({ startedSecAgo: 35, lastTickSecAgo: 35 })
    const before = callDoc().lastTickAt.toMillis()
    const r = await tick(EARNER)
    expect(r.charged).toBe(0)
    expect(diamonds()).toBe(1000)
    expect(callDoc().tickIndex).toBe(0)
    expect(callDoc().lastTickAt.toMillis()).toBe(before)
  })
  test('the PAYER tick bills the whole ticks outstanding (control)', async () => {
    seedCall({ startedSecAgo: 35, lastTickSecAgo: 5 })
    const r = await tick(PAYER)
    expect(r.charged).toBe(30)
    expect(diamonds()).toBe(970)
    expect(callDoc().tickIndex).toBe(3)
  })
})

describe('the payer tick ends the call — and charges nothing more — when the gate fails', () => {
  const cases = [
    ['the payer is banned', () => db.seed(`users/${PAYER}`, { diamonds: 1000, isBanned: true, accountState: 'banned' }), token(), {}, 'party_restricted'],
    ['the earner is suspended', () => db.seed(`users/${EARNER}`, { isSuspended: true, isBanned: true, accountState: 'suspended' }), token(), {}, 'party_restricted'],
    ['the payer is deleting the account', () => db.seed(`users/${PAYER}`, { diamonds: 1000, isDeleted: true, accountState: 'recovery_pending' }), token(), {}, 'party_restricted'],
    ['the payer sign-in predates the cut-off', () => db.seed(`users/${PAYER}`, { diamonds: 1000, credentialsValidAfter: 3000 }), token(2000), {}, 'session_displaced'],
    ['the payer presents a session that is no longer active', () => db.seed(`users/${PAYER}`, { diamonds: 1000, activeMobileSession: { sessionId: 'NEW-PHONE' } }), token(), { sessionId: 'OLD-PHONE' }, 'session_displaced'],
  ]
  for (const [label, arrange, tok, data, reason] of cases) {
    test(`${label} → endNow, nothing charged, reason ${reason}`, async () => {
      seedCall({ startedSecAgo: 35, lastTickSecAgo: 25, tickIndex: 1 })
      arrange()
      const r = await tick(PAYER, data, tok)
      expect(r.endNow).toBe(true)
      expect(r.charged).toBe(0)
      expect(diamonds()).toBe(1000)
      expect(callDoc().status).toBe('ending')
      expect(callDoc().endReason).toBe(reason)
    })
  }

  test('…and settling that call bills nothing past the last tick, keeping the server reason', async () => {
    seedCall({ startedSecAgo: 95, lastTickSecAgo: 85, tickIndex: 1 })
    db.seed(`users/${EARNER}`, { isBanned: true, accountState: 'banned' })
    await tick(PAYER)
    const r = await end(PAYER, 'diamonds_exhausted')
    expect(r.diamondsCharged).toBe(10)          // the one tick already billed, nothing more
    expect(diamonds()).toBe(1000)               // seeded balance; the earlier tick was seeded, not debited
    expect(callDoc().status).toBe('ended')
    expect(callDoc().endReason).toBe('party_restricted')
  })
})

describe('settlement bills up to the payer\'s last tick plus one tick of grace', () => {
  test('payer went silent 200 s ago: the earner hanging up bills ONE grace tick, not twenty', async () => {
    seedCall({ startedSecAgo: 300, lastTickSecAgo: 200, tickIndex: 10 })
    const r = await end(EARNER, 'receiver_ended')
    expect(r.diamondsCharged).toBe(110)         // 10 billed ticks + 1 grace tick
    expect(diamonds()).toBe(990)
  })
  test('a payer ticking normally and hanging up is billed exactly as before (control)', async () => {
    seedCall({ startedSecAgo: 25, lastTickSecAgo: 5, tickIndex: 2 })
    const r = await end(PAYER, 'caller_ended')
    expect(r.diamondsCharged).toBe(20)
    expect(diamonds()).toBe(1000)
  })
  test('the watchdog settles through the same capped function', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'calls.ts'), 'utf8')
    const sweep = src.slice(src.indexOf('export const sweepStaleCalls'))
    expect(sweep.includes("settleAndClose(doc.id, null, 'watchdog_timeout')")).toBe(true)
  })
})

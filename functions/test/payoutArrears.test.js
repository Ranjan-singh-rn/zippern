/**
 * M-5 / F-22 — the payout arrears flag (OWNER_DECISION_PENDING).
 *
 * `releaseBeansForWeek` reads `appConfig/economy.payoutReleaseArrearsWeeks`
 * (an integer >= 0, default 0) and moves its release cutoff back that many
 * weeks. 0 must be exactly today's behaviour: the Monday 00:30 IST run
 * releases the ISO week that closed half an hour earlier. 1 holds that week
 * until the following Monday's run.
 *
 * The clock is pinned to a scheduled run: Monday 2 Nov 2026 00:30 IST
 * (Sunday 1 Nov 19:00 UTC). The week that has just closed is 2026-W44
 * (26 Oct to 1 Nov), the one before it 2026-W43, the one just begun 2026-W45.
 *
 * Run:  node --test test/payoutArrears.test.js
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const P = require('../lib/payouts')

const DAY_MS = 24 * 60 * 60 * 1000
const RUN = Date.parse('2026-11-01T19:00:00Z')          // Monday 2 Nov 2026, 00:30 IST
const run = () => P.releaseBeansForWeek.run({}, {})

const weekDoc = (wk) => db.read(`users/H/weeklyEarnings/${wk}`)
const available = () => db.read('users/H').beansAvailable

function economy(extra = {}) {
  db.seed('appConfig/economy', { giftRates: { beanToInrRate: 0.01 }, ...extra })
}

/** Everything the run writes to stdout/stderr (the functions logger), as one string. */
async function logsOf(fn) {
  const chunks = []
  const ow = process.stdout.write, ew = process.stderr.write
  process.stdout.write = function (c, ...a) { chunks.push(String(c)); return ow.call(this, c, ...a) }
  process.stderr.write = function (c, ...a) { chunks.push(String(c)); return ew.call(this, c, ...a) }
  try {
    await fn()
  } finally {
    process.stdout.write = ow
    process.stderr.write = ew
  }
  return chunks.join('')
}

beforeEach(() => {
  db._docs.clear()
  mock.timers.enable({ apis: ['Date'], now: RUN })
  db.seed('users/H', { name: 'H', isHost: true, isVerifiedHost: true, beans: 700, beansAvailable: 0 })
  for (const [wk, beans] of [['2026-W43', 100], ['2026-W44', 200], ['2026-W45', 400]]) {
    db.seed(`users/H/weeklyEarnings/${wk}`, { weekKey: wk, beans, giftBeans: beans, released: false })
  }
})
afterEach(() => mock.timers.reset())

describe('the cutoff and the flag (pure)', () => {
  test('0 is the cutoff the job always used; each further week moves it back one', () => {
    expect(P.releaseCutoffWeekKey(RUN, 0)).toBe('2026-W44')
    expect(P.releaseCutoffWeekKey(RUN, 0)).toBe(P.istWeekKey(new Date(RUN - 7 * DAY_MS)))
    expect(P.releaseCutoffWeekKey(RUN, 1)).toBe('2026-W43')
    expect(P.releaseCutoffWeekKey(RUN, 2)).toBe('2026-W42')
  })

  test('absent or null is 0; a whole number from 0 to 52 is taken; anything else is 0 and invalid', () => {
    expect(P.PAYOUT_RELEASE_ARREARS_FIELD).toBe('payoutReleaseArrearsWeeks')
    expect(P.payoutReleaseArrearsWeeks(undefined)).toEqual({ weeks: 0, valid: true })
    expect(P.payoutReleaseArrearsWeeks(null)).toEqual({ weeks: 0, valid: true })
    expect(P.payoutReleaseArrearsWeeks(0)).toEqual({ weeks: 0, valid: true })
    expect(P.payoutReleaseArrearsWeeks(1)).toEqual({ weeks: 1, valid: true })
    expect(P.payoutReleaseArrearsWeeks(52)).toEqual({ weeks: 52, valid: true })
    for (const bad of [-1, 1.5, '1', true, 53, NaN, Infinity, {}]) {
      expect(P.payoutReleaseArrearsWeeks(bad)).toEqual({ weeks: 0, valid: false })
    }
  })
})

describe('releaseBeansForWeek with the flag', () => {
  test('0: today\'s behaviour. The week that just closed is released with every earlier one', async () => {
    economy({ payoutReleaseArrearsWeeks: 0 })
    const logs = await logsOf(run)
    expect(weekDoc('2026-W43').released).toBe(true)
    expect(weekDoc('2026-W44').released).toBe(true)
    expect(weekDoc('2026-W45').released).toBe(false)     // the week that began 30 minutes ago
    expect(available()).toBe(300)
    expect(logs.includes('cutoff 2026-W44 (0 week(s) in arrears)')).toBe(true)
  })

  test('absent: identical to 0', async () => {
    economy()
    await run()
    expect(weekDoc('2026-W44').released).toBe(true)
    expect(weekDoc('2026-W45').released).toBe(false)
    expect(available()).toBe(300)
  })

  test('1: the week that just closed waits one more week, untouched; the following Monday releases it', async () => {
    economy({ payoutReleaseArrearsWeeks: 1 })
    const logs = await logsOf(run)
    expect(weekDoc('2026-W43').released).toBe(true)
    expect(weekDoc('2026-W44').released).toBe(false)
    expect(weekDoc('2026-W44').skippedReason).toBe(undefined)   // not held for a cause: simply not due
    expect(db.has('users/H/weeklyStatements/2026-W44')).toBe(false)
    expect(available()).toBe(100)
    expect(logs.includes('cutoff 2026-W43 (1 week(s) in arrears)')).toBe(true)

    mock.timers.setTime(RUN + 7 * DAY_MS)                 // Monday 9 Nov 2026, 00:30 IST
    await run()
    expect(weekDoc('2026-W44').released).toBe(true)
    expect(weekDoc('2026-W45').released).toBe(false)
    expect(available()).toBe(300)
    expect(db.read('users/H/weeklyStatements/2026-W44').beansReleased).toBe(200)
  })

  test('an invalid value releases as 0 (never a silent freeze) and says so in the log', async () => {
    economy({ payoutReleaseArrearsWeeks: '1' })
    const logs = await logsOf(run)
    expect(weekDoc('2026-W44').released).toBe(true)
    expect(available()).toBe(300)
    expect(logs.includes('payoutReleaseArrearsWeeks is \\"1\\", not a whole number from 0 to 52')).toBe(true)
  })
})

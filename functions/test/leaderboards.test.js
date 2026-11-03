/**
 * B8 (3 Nov 2026) — leaderboards and rewards.
 *
 *   * IST periods: the day, the ISO week and the month a moment belongs to, cut at midnight IST; which periods
 *     have CLOSED at 00:15 IST (yesterday; last week on Mondays; last month on the 1st).
 *   * Scores accrue in the money's own transaction: the SHIPPED settleGift adds what the sender spent (supporters)
 *     and what a host earned (hosts) to the day, week and month; a replayed gift adds nothing.
 *   * The Owner's tiers are cleaned (ranks 1–50, no overlaps); lucky stays off unless switched on.
 *   * Settlement pays each rank its tier once — a second run pays nothing — ties broken by uid, restricted and
 *     excluded accounts skipped (and recorded), every reward a ledger row and a `promoCredits` row.
 *
 * Run:  node --test test/leaderboards.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
const L = require('../lib/leaderboards')
const gifts = require('../lib/gifts')

const at = (iso) => new Date(iso)

describe('IST periods', () => {
  test('the day turns at midnight IST', () => {
    expect(L.periodKeys(at('2026-11-03T18:29:59Z')).daily).toBe('2026-11-03')
    expect(L.periodKeys(at('2026-11-03T18:30:00Z')).daily).toBe('2026-11-04')
  })
  test('the week is the ISO week cut in IST; the month likewise', () => {
    expect(L.periodKeys(at('2026-11-08T18:29:59Z')).weekly).toBe('2026-W45')   // Sunday 23:59 IST
    expect(L.periodKeys(at('2026-11-08T18:30:00Z')).weekly).toBe('2026-W46')   // Monday 00:00 IST
    expect(L.periodKeys(at('2026-11-30T18:29:59Z')).monthly).toBe('2026-11')
    expect(L.periodKeys(at('2026-11-30T18:30:00Z')).monthly).toBe('2026-12')
  })
  test('what has closed at 00:15 IST', () => {
    expect(L.closedPeriods(at('2026-11-09T18:45:00Z'))).toEqual([{ period: 'daily', key: '2026-11-09' }])             // Tue
    expect(L.closedPeriods(at('2026-11-08T18:45:00Z'))).toEqual([
      { period: 'daily', key: '2026-11-08' }, { period: 'weekly', key: '2026-W45' }])                                    // Mon
    expect(L.closedPeriods(at('2026-11-30T18:45:00Z'))).toEqual([
      { period: 'daily', key: '2026-11-30' }, { period: 'monthly', key: '2026-11' }])                                    // 1 Dec
  })
})

describe('the Owner\'s tiers', () => {
  test('ranks 1–50, from ≤ to, positive amounts, no overlaps', () => {
    expect(L.cleanTiers([
      { from: 1, to: 1, amount: 5000 }, { from: 2, to: 3, amount: 2000 }, { from: 3, to: 5, amount: 99 },
      { from: 0, to: 1, amount: 1 }, { from: 4, to: 60, amount: 1 }, { from: 6, to: 10, amount: -5 }, { from: 11, to: 50, amount: 100 },
    ])).toEqual([{ from: 1, to: 1, amount: 5000 }, { from: 2, to: 3, amount: 2000 }, { from: 11, to: 50, amount: 100 }])
    expect(L.rewardFor(1, [{ from: 1, to: 1, amount: 5 }])).toBe(5)
    expect(L.rewardFor(2, [{ from: 1, to: 1, amount: 5 }])).toBe(0)
  })
  test('defaults: rankings shown, nothing paid; lucky off; beans only for hosts', () => {
    const d = L.mergeLeaderboardsConfig(undefined)
    expect(d.enabled).toBe(true)
    expect(d.boards.lucky.enabled).toBe(false)
    expect(d.boards.hosts.weekly.tiers).toEqual([])
    const m = L.mergeLeaderboardsConfig({ boards: { lucky: { enabled: 'yes' }, supporters: { daily: { currency: 'beans' } }, hosts: { daily: { currency: 'beans' } } } })
    expect(m.boards.lucky.enabled).toBe(false)
    expect(m.boards.supporters.daily.currency).toBe('diamonds')
    expect(m.boards.hosts.daily.currency).toBe('beans')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const S = 'SENDER'
const H = 'HOST'
const token = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
const send = (data) => gifts.settleGift.run({ data: { context: 'dm', ...data }, auth: { uid: S, token } })
const entry = (board, period, key, uid) => db.read(`leaderboards/${L.boardDocId(board, period, key)}/entries/${uid}`)

beforeEach(() => {
  db._docs.clear()
  db.seed(`users/${S}`, { name: 'Sender', displayName: 'Sender', diamonds: 5000, photoUrl: 'p.jpg' })
  db.seed(`users/${H}`, { name: 'Host', displayName: 'Host', beans: 0, isHost: true, isVerifiedHost: true })
  db.seed('gifts/crown', { name: 'Crown', category: 'normal', diamondCost: 33, earningRate: 52, isActive: true })
})

describe('scores accrue where the money moves', () => {
  test('a gift adds the diamonds spent to the sender and the beans earned to the host — day, week and month', async () => {
    await send({ giftId: 'crown', receiverUid: H, quantity: 3, idempotencyKey: 'g1-key-xx' })
    const k = L.periodKeys(new Date())
    for (const period of L.PERIODS) {
      expect(entry('supporters', period, k[period], S)).toMatchObject({ uid: S, score: 99, name: 'Sender', photoUrl: 'p.jpg' })
      expect(entry('hosts', period, k[period], H)).toMatchObject({ uid: H, score: 51, name: 'Host' })
    }
    await send({ giftId: 'crown', receiverUid: H, quantity: 1, idempotencyKey: 'g2-key-xx' })
    expect(entry('supporters', 'daily', k.daily, S).score).toBe(132)
    // The same request again: answered from the first, counted once.
    await send({ giftId: 'crown', receiverUid: H, quantity: 1, idempotencyKey: 'g2-key-xx' })
    expect(entry('supporters', 'daily', k.daily, S).score).toBe(132)
    expect(entry('lucky', 'daily', k.daily, S)).toBe(undefined)
  })
  test('a gift to somebody who is not a host counts for the sender only', async () => {
    db.seed(`users/${H}`, { name: 'Friend', displayName: 'Friend', beans: 0 })
    await send({ giftId: 'crown', receiverUid: H, quantity: 1, idempotencyKey: 'g3-key-xx' })
    const k = L.periodKeys(new Date())
    expect(entry('hosts', 'daily', k.daily, H)).toBe(undefined)
    expect(entry('supporters', 'daily', k.daily, S).score).toBe(33)
  })
})

describe('settlement', () => {
  const KEY = '2026-11-02'
  const id = L.boardDocId('supporters', 'daily', KEY)
  function board(scores) {
    for (const [uid, score] of Object.entries(scores)) {
      db.seed(`users/${uid}`, { name: uid, diamonds: 100 })
      db.seed(`leaderboards/${id}/entries/${uid}`, { uid, score, name: uid })
    }
  }
  const cfg = (tiers) => L.mergeLeaderboardsConfig({ boards: { supporters: { daily: { tiers } } } })

  test('each rank its tier, once; a second run pays nothing', async () => {
    board({ a: 900, b: 700, c: 700, d: 100, e: 0 })
    const tiers = [{ from: 1, to: 1, amount: 500 }, { from: 2, to: 3, amount: 200 }, { from: 4, to: 10, amount: 50 }]
    const r = await L.settleBoard('supporters', 'daily', KEY, cfg(tiers))
    expect(r).toEqual({ boardDocId: id, status: 'settled', paid: 4, total: 500 + 200 + 200 + 50 })
    expect(db.read('users/a').diamonds).toBe(600)
    expect(db.read('users/b').diamonds).toBe(300)       // the tie: b before c by uid, both in the 2–3 tier
    expect(db.read('users/c').diamonds).toBe(300)
    expect(db.read('users/d').diamonds).toBe(150)
    expect(db.read('users/e').diamonds).toBe(100)       // a zero score is not on the board
    expect(db.read(`users/a/diamondTransactions/lb_${id}`)).toMatchObject({ type: 'credit', amount: 500, balanceAfter: 600, reason: 'leaderboard_reward', rank: 1 })
    expect(db.read(`promoCredits/lb_${id}_1`)).toMatchObject({ kind: 'leaderboard_reward', uid: 'a', diamonds: 500 })
    expect(db.read(`leaderboardSettlements/${id}`).winners.map((w) => w.uid)).toEqual(['a', 'b', 'c', 'd'])
    const again = await L.settleBoard('supporters', 'daily', KEY, cfg(tiers))
    expect(again.status).toBe('already')
    expect(db.read('users/a').diamonds).toBe(600)
  })

  test('restricted and excluded accounts are skipped, and the settlement says so', async () => {
    board({ a: 900, b: 800, c: 700 })
    db.seed('users/a', { name: 'a', diamonds: 100, accountStatus: 'banned', isBanned: true })
    db.seed('users/b', { name: 'b', diamonds: 100, excludeFromLeaderboards: true })
    const r = await L.settleBoard('supporters', 'daily', KEY, cfg([{ from: 1, to: 3, amount: 100 }]))
    expect(r.paid).toBe(1)
    expect(db.read('users/a').diamonds).toBe(100)
    expect(db.read('users/b').diamonds).toBe(100)
    expect(db.read('users/c').diamonds).toBe(200)
    const w = db.read(`leaderboardSettlements/${id}`).winners
    expect(w.find((x) => x.uid === 'a').skipped).toBe('restricted')
    expect(w.find((x) => x.uid === 'b').skipped).toBe('excluded')
  })

  test('no tiers, a board switched off, or the master switch off: nothing is paid and nothing is recorded', async () => {
    board({ a: 900 })
    expect((await L.settleBoard('supporters', 'daily', KEY, cfg([]))).status).toBe('off')
    const off = L.mergeLeaderboardsConfig({ enabled: false, boards: { supporters: { daily: { tiers: [{ from: 1, to: 1, amount: 9 }] } } } })
    expect((await L.settleBoard('supporters', 'daily', KEY, off)).status).toBe('off')
    expect(db.read(`leaderboardSettlements/${id}`)).toBe(undefined)
    expect(db.read('users/a').diamonds).toBe(100)
  })

  test('hosts can be rewarded in beans', async () => {
    const hid = L.boardDocId('hosts', 'daily', KEY)
    db.seed('users/h1', { name: 'h1', beans: 10, isHost: true })
    db.seed(`leaderboards/${hid}/entries/h1`, { uid: 'h1', score: 500 })
    const c = L.mergeLeaderboardsConfig({ boards: { hosts: { daily: { currency: 'beans', tiers: [{ from: 1, to: 1, amount: 300 }] } } } })
    await L.settleBoard('hosts', 'daily', KEY, c)
    expect(db.read('users/h1').beans).toBe(310)
    expect(db.read(`promoCredits/lb_${hid}_1`)).toMatchObject({ beans: 300 })
  })

  test('the scheduled pass settles every board whose period has closed', async () => {
    db.seed('appConfig/leaderboards', { boards: { supporters: { daily: { tiers: [{ from: 1, to: 1, amount: 10 }] } } } })
    board({ a: 5 })
    const r = await L.settleLeaderboardsOnce(at('2026-11-02T18:45:00Z'))  // 00:15 IST, 3 Nov (a Tuesday)
    expect(r.find((x) => x.boardDocId === id).status).toBe('settled')
    expect(db.read('users/a').diamonds).toBe(110)
  })
})

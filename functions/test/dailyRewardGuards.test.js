/**
 * F-9 / M-22 (audit 2026-11-01) — who may claim the daily reward.
 *
 *   * a banned, suspended or deletion-requested account is refused
 *     (`ACCOUNT_RESTRICTED`) — including when the restriction lands between
 *     the session gate and the paying transaction;
 *   * `appConfig/economy.dailyRewardRequiresVerifiedContact` (default false)
 *     — when true, a token with neither a phone number nor a verified email
 *     is refused `VERIFIED_CONTACT_REQUIRED` and nothing is credited; when
 *     absent or false, a guest is credited exactly as before;
 *   * OWNER_DECISION_PENDING (Q6): ring-fencing reward diamonds is NOT
 *     implemented here; only the two guards above.
 *
 * The shipped `claimDailyReward` over the fake Firestore.
 *
 * Run:  node --test test/dailyRewardGuards.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const W = require('../lib/wallet')
const { istDateKey } = require('../lib/time')

const nowSec = () => Math.floor(Date.now() / 1000)
const GUEST = { auth_time: nowSec() - 60, firebase: { sign_in_provider: 'anonymous' } }
const PHONE = { auth_time: nowSec() - 60, firebase: { sign_in_provider: 'phone' }, phone_number: '+919800000000' }
const CUSTOM_WITH_PHONE = { auth_time: nowSec() - 60, firebase: { sign_in_provider: 'custom' }, phone_number: '+919800000000' }
const EMAIL_UNVERIFIED = { auth_time: nowSec() - 60, firebase: { sign_in_provider: 'password' }, email: 'a@example.com', email_verified: false }
const EMAIL_VERIFIED = { auth_time: nowSec() - 60, firebase: { sign_in_provider: 'google.com' }, email: 'a@example.com', email_verified: true }

const claim = (uid, token) => W.claimDailyReward.run({}, { auth: { uid, token } })
async function refusal(p) { try { await p } catch (e) { return e } return null }
const detail = (e) => (e && e.details ? e.details.code : undefined)
const user = (uid) => db.read(`users/${uid}`)
const claimed = (uid) => db.has(`users/${uid}/dailyClaims/${istDateKey()}`)

function seed(uid, extra = {}) {
  db.seed(`users/${uid}`, { name: uid, accountState: 'active', diamonds: 10, ...extra })
}

beforeEach(() => { db._docs.clear() })

describe('the default: no flag, no restriction — a guest is credited exactly as before', () => {
  test('day one of the fallback schedule: 50 diamonds, the claim, the ledger row', async () => {
    seed('G')
    const r = await claim('G', GUEST)
    expect(r).toEqual({ day: 1, diamonds: 50, videoCards: 0 })
    expect(user('G').diamonds).toBe(60)
    expect(user('G').dailyStreak).toBe(1)
    expect(claimed('G')).toBe(true)
    const rows = db.all('users/G/diamondTransactions')
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('daily_reward')
    expect(rows[0].amount).toBe(50)
  })

  test('a second claim the same day is already-exists', async () => {
    seed('G')
    await claim('G', GUEST)
    const e = await refusal(claim('G', GUEST))
    expect(e && e.code).toBe('already-exists')
    expect(user('G').diamonds).toBe(60)
  })

  test('a flag that is present but not exactly `true` changes nothing', async () => {
    for (const v of ['true', 1, 'yes', null, {}]) {
      db._docs.clear()
      db.seed('appConfig/economy', { dailyRewardRequiresVerifiedContact: v })
      seed('G')
      expect((await claim('G', GUEST)).diamonds).toBe(50)
    }
  })
})

describe('F-9: a restricted account cannot claim', () => {
  for (const [label, extra, state] of [
    ['banned', { isBanned: true }, 'banned'],
    ['suspended', { isSuspended: true }, 'suspended'],
    ['banned by accountState', { accountState: 'banned' }, 'banned'],
    ['deletion requested', { isDeleted: true, accountState: 'recovery_pending' }, 'deletion_requested'],
  ]) {
    test(`${label}: refused, nothing credited, no claim written`, async () => {
      seed('B', extra)
      const e = await refusal(claim('B', PHONE))
      expect(e && e.code).toBe('permission-denied')
      expect(detail(e)).toBe('ACCOUNT_RESTRICTED')
      expect(e.details.state).toBe(state)
      expect(user('B').diamonds).toBe(10)
      expect(claimed('B')).toBe(false)
      expect(db.count('users/B/diamondTransactions')).toBe(0)
    })
  }

  test('a ban landing between the session gate and the paying transaction is still honoured', async () => {
    seed('B')
    const original = db.runTransaction.bind(db)
    let intercepted = false
    db.runTransaction = (fn) => {
      if (!intercepted) {
        intercepted = true
        db.seed('users/B', { ...user('B'), isBanned: true })
      }
      return original(fn)
    }
    try {
      const e = await refusal(claim('B', PHONE))
      expect(intercepted).toBe(true)
      expect(detail(e)).toBe('ACCOUNT_RESTRICTED')
    } finally {
      db.runTransaction = original
    }
    expect(user('B').diamonds).toBe(10)
    expect(claimed('B')).toBe(false)
  })
})

describe('M-22: appConfig/economy.dailyRewardRequiresVerifiedContact', () => {
  beforeEach(() => { db.seed('appConfig/economy', { dailyRewardRequiresVerifiedContact: true }) })

  test('a guest (anonymous token) is refused VERIFIED_CONTACT_REQUIRED and nothing is written', async () => {
    seed('G')
    const writes = db.writes
    const e = await refusal(claim('G', GUEST))
    expect(e && e.code).toBe('failed-precondition')
    expect(detail(e)).toBe('VERIFIED_CONTACT_REQUIRED')
    expect(db.writes).toBe(writes)
    expect(user('G').diamonds).toBe(10)
    expect(claimed('G')).toBe(false)
  })

  test('an unverified email does not count as a contact', async () => {
    seed('E')
    expect(detail(await refusal(claim('E', EMAIL_UNVERIFIED)))).toBe('VERIFIED_CONTACT_REQUIRED')
  })

  test('a phone number, a verified email, or a quick-login (custom) session on a phone account all qualify', async () => {
    seed('P'); seed('V'); seed('C')
    expect((await claim('P', PHONE)).diamonds).toBe(50)
    expect((await claim('V', EMAIL_VERIFIED)).diamonds).toBe(50)
    expect((await claim('C', CUSTOM_WITH_PHONE)).diamonds).toBe(50)
  })

  test('the decision is read from the VERIFIED token, not from what the document claims', async () => {
    seed('G', { phoneNumber: '+919800000000', email: 'a@example.com' })
    expect(detail(await refusal(claim('G', GUEST)))).toBe('VERIFIED_CONTACT_REQUIRED')
  })

  test('the restriction check comes first, whatever the flag', async () => {
    seed('B', { isBanned: true })
    expect(detail(await refusal(claim('B', GUEST)))).toBe('ACCOUNT_RESTRICTED')
  })
})

describe('dailyRewardRequiresVerifiedContact — pure', () => {
  test('only a literal true turns it on', () => {
    expect(W.dailyRewardRequiresVerifiedContact({ dailyRewardRequiresVerifiedContact: true })).toBe(true)
    for (const v of [false, 'true', 1, undefined, null]) {
      expect(W.dailyRewardRequiresVerifiedContact({ dailyRewardRequiresVerifiedContact: v })).toBe(false)
    }
    expect(W.dailyRewardRequiresVerifiedContact(undefined)).toBe(false)
    expect(W.dailyRewardRequiresVerifiedContact(null)).toBe(false)
    expect(W.dailyRewardRequiresVerifiedContact({})).toBe(false)
  })
})

/**
 * RC (confirmed, CRM-FLOW 9.48) — a Host's earnings frozen for the Owner's
 * review do not move on the Cloud Functions side either.
 *
 * The backend writes `users/{uid}.payoutHold = true` in the same write as a
 * suspension, ban or Host revocation (`money_freeze.hold_fields`, asserted in
 * backend/tests/test_rc_money_freeze.py). Here:
 *
 *   * `convertBeans` refuses while the hold is on (it used to convert frozen
 *     beans into spendable diamonds);
 *   * the weekly bean release skips a held account (pinned at source level —
 *     it is a scheduled collection-group job).
 *
 * Run:  node --test test/rcMoneyFreeze.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const W = require('../lib/wallet')

async function refusal(p) { try { await p } catch (e) { return e } return null }
const call = (uid, data) => W.convertBeans.run(data, { auth: { uid, token: { firebase: { sign_in_provider: 'phone' } } } })

describe('convertBeans honours the freeze', () => {
  beforeEach(() => {
    db._docs.clear()
    db.seed('appConfig/economy', { beanToDiamondRate: 20 })
  })

  test('a held Host cannot convert frozen beans', async () => {
    db.seed('users/H1', { name: 'H', beans: 1000, beansAvailable: 1000, payoutHold: true,
      payoutHoldReason: 'frozen_for_owner_review: a suspension' })
    const e = await refusal(call('H1', { beansAmount: 100, idempotencyKey: 'k1' }))
    expect(e && e.code).toBe('failed-precondition')
    expect(e && e.details && e.details.code).toBe('payout_hold')
    expect(db.read('users/H1').beans).toBe(1000)
  })

  test('the hold is read before anything is written (no idempotency claim left behind)', async () => {
    db.seed('users/H2', { name: 'H', beans: 1000, beansAvailable: 1000, payoutHold: true })
    await refusal(call('H2', { beansAmount: 100, idempotencyKey: 'k2' }))
    expect(db.read('walletIdempotency/H2_k2')).toBe(undefined)
  })
})

describe('the weekly release skips a held account (source)', () => {
  test('releaseBeansForWeek refuses to release while payoutHold is set', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'payouts.ts'), 'utf8')
    const body = src.slice(src.indexOf('export const releaseBeansForWeek'))
    expect(/userSnap\.get\('payoutHold'\) === true[\s\S]{0,80}SKIP_HOLD/.test(body)).toBe(true)
  })
})

/**
 * Google sign-in for an email that already has an account (2026-10-08 bug):
 * the Google uid must resolve to the EXISTING account, never a second one —
 * and only when that is provably the same mailbox.
 *
 * Run:  node --test test/emailAdoption.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { decideEmailAdoption, ADOPTION_WINDOW_MS } = require('../lib/emailAdoption')

const holder = (over = {}) => ({
  uid: 'UID_GUEST',
  authEmail: 'x@gmail.com',
  authEmailVerified: true,
  disabled: false,
  accountState: 'active',
  ...over,
})

const base = (over = {}) => decideEmailAdoption({
  callerUid: 'UID_NEW_GOOGLE',
  signInProvider: 'google.com',
  email: 'x@gmail.com',
  emailVerified: true,
  callerProviders: ['google.com'],
  callerAgeMs: 5_000,
  callerHasData: false,
  candidates: [holder()],
  ...over,
})

describe('the reported bug: guest bound x@gmail.com, then Google with x@gmail.com', () => {
  test('resolves to the guest account, not a new one', () => {
    const d = base()
    expect(d.action).toBe('adopt')
    expect(d.targetUid).toBe('UID_GUEST')
  })
})

describe('never adopts unless it is provably the same mailbox', () => {
  test('a holder whose email is NOT verified on Auth', () => {
    expect(base({ candidates: [holder({ authEmailVerified: false })] }).action).toBe('none')
  })
  test('a holder whose Auth email differs from the users doc', () => {
    expect(base({ candidates: [holder({ authEmail: 'other@gmail.com' })] }).action).toBe('none')
  })
  test('the caller token email is unverified', () => {
    expect(base({ emailVerified: false })).toEqual({ action: 'none', reason: 'email_unverified' })
  })
  test('not a Google sign-in (phone, password, anonymous)', () => {
    for (const p of ['phone', 'password', 'anonymous', 'custom']) {
      expect(base({ signInProvider: p })).toEqual({ action: 'none', reason: 'not_google' })
    }
  })
})

describe('never discards an account that is somebody\'s', () => {
  test('caller older than the window', () => {
    expect(base({ callerAgeMs: ADOPTION_WINDOW_MS + 1 }).reason).toBe('caller_not_fresh')
  })
  test('caller has another provider too', () => {
    expect(base({ callerProviders: ['google.com', 'phone'] }).reason).toBe('caller_not_fresh')
  })
  test('caller already has a profile or balance', () => {
    expect(base({ callerHasData: true }).reason).toBe('caller_has_data')
  })
})

describe('holders that do not count', () => {
  test('the caller itself', () => {
    expect(base({ candidates: [holder({ uid: 'UID_NEW_GOOGLE' })] }).reason).toBe('no_holder')
  })
  test('a disabled account', () => {
    expect(base({ candidates: [holder({ disabled: true })] }).reason).toBe('no_holder')
  })
  test('a permanently deactivated account', () => {
    expect(base({ candidates: [holder({ accountState: 'permanently_deactivated' })] }).reason).toBe('no_holder')
  })
  test('no holder at all → an ordinary new Google account', () => {
    expect(base({ candidates: [] })).toEqual({ action: 'none', reason: 'no_holder' })
  })
  test('two live holders → ambiguous, nothing is chosen', () => {
    const d = base({ candidates: [holder(), holder({ uid: 'UID_OTHER' })] })
    expect(d).toEqual({ action: 'none', reason: 'ambiguous' })
  })
})

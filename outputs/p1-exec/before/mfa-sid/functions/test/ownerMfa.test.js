/**
 * P1-A3b — Owner callables require the Owner MFA binding, not just the role.
 *
 * `backfillPublicProfiles` used to admit any sign-in whose crmUsers.role was
 * `superadmin` — true for a password-only sign-in that never passed MFA. It now
 * also requires `ownerMfaSessions/{uid}.active["<auth_time>:<provider>"]` to be
 * live, exactly as firestore.rules / storage.rules do.
 *
 * Run:  node --test test/ownerMfa.test.js
 */

const { test, describe } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')

const { ownerMfaKey, ownerMfaBindingValid, ownerMfaVerified } = require('../lib/ownerMfa')

const NOW = 1_800_000_000_000
const token = (auth_time, provider = 'password') => ({ auth_time, firebase: { sign_in_provider: provider } })
const ts = (ms) => ({ toMillis: () => ms })

function fakeDb(docs) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          if (docs === 'throw') throw new Error('unavailable')
          const d = (docs[name] || {})[id]
          return { exists: d !== undefined, data: () => d }
        },
      }),
    }),
  }
}

describe('the binding key matches the rules', () => {
  test('auth_time:provider', () => {
    expect(ownerMfaKey(token(1000))).toBe('1000:password')
    expect(ownerMfaKey(token(2000, 'phone'))).toBe('2000:phone')
    expect(ownerMfaKey(undefined)).toBe('0:')
  })
})

describe('binding validity', () => {
  const data = { active: { '1000:password': ts(NOW + 60_000), '900:password': ts(NOW - 1) } }
  test('a live key passes', () => expect(ownerMfaBindingValid(data, token(1000), NOW)).toBe(true))
  test('an expired key fails', () => expect(ownerMfaBindingValid(data, token(900), NOW)).toBe(false))
  test('a different sign-in (auth_time) fails', () => expect(ownerMfaBindingValid(data, token(1001), NOW)).toBe(false))
  test('a different provider fails', () => expect(ownerMfaBindingValid(data, token(1000, 'phone'), NOW)).toBe(false))
  test('no document fails', () => expect(ownerMfaBindingValid(undefined, token(1000), NOW)).toBe(false))
  test('no token fails', () => expect(ownerMfaBindingValid(data, undefined, NOW)).toBe(false))
})

describe('ownerMfaVerified reads ownerMfaSessions/{uid}', () => {
  const db = fakeDb({ ownerMfaSessions: { own1: { active: { '1000:password': ts(NOW + 60_000) } } } })
  test('bound Owner sign-in → true', async () => expect(await ownerMfaVerified(db, 'own1', token(1000), NOW)).toBe(true))
  test('pending Owner (no document) → false', async () => expect(await ownerMfaVerified(db, 'own2', token(1000), NOW)).toBe(false))
  test('another sign-in of the same Owner → false', async () => expect(await ownerMfaVerified(db, 'own1', token(5), NOW)).toBe(false))
  test('an unreadable document fails closed', async () =>
    expect(await ownerMfaVerified(fakeDb('throw'), 'own1', token(1000), NOW)).toBe(false))
})

describe('backfillPublicProfiles enforces it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'profiles.ts'), 'utf8')
  const body = src.slice(src.indexOf('export const backfillPublicProfiles'))
  test('checks the role, then the MFA binding, before any write', () => {
    const role = body.indexOf("!== OWNER_ROLE")
    const mfa = body.indexOf('ownerMfaVerified(db, uid, context.auth?.token')
    const firstWrite = body.indexOf('db.batch()')
    expect(role > 0 && mfa > role && firstWrite > mfa).toBe(true)
  })
  test('refuses with permission-denied', () => {
    expect(body.includes("'Finish two-step sign-in in the CRM first, then try again.'")).toBe(true)
  })
})

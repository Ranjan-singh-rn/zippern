/**
 * P1-A3b — Owner callables require the per-session `mfa_sid` binding.
 *
 * `backfillPublicProfiles` admits an Owner only when the caller's token carries
 * `mfa_sid` (custom-token sign-in, provider 'custom') naming an ACTIVE,
 * unexpired binding in ownerMfaSessions/{uid} whose authTime equals the token's
 * auth_time — exactly as firestore.rules / storage.rules do. The Storage-claim
 * trigger never persists `mfa_sid` as an account-wide claim.
 *
 * Run:  node --test test/ownerMfa.test.js
 */

const { test, describe } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')

const { ownerMfaBindingValid, ownerMfaVerified } = require('../lib/ownerMfa')
const { syncClaim } = require('../lib/storageClaims')

const NOW = 1_800_000_000_000
const ts = (ms) => ({ toMillis: () => ms })
const tok = (auth_time, extra = {}, provider = 'custom') =>
  ({ auth_time, firebase: { sign_in_provider: provider }, ...extra })
const DATA = {
  bindings: {
    SID_LIVE: { state: 'active', authTime: 1000, expiresAt: ts(NOW + 60_000) },
    SID_MINTED: { state: 'minted', expiresAt: ts(NOW + 60_000) },
    SID_EXPIRED: { state: 'active', authTime: 1000, expiresAt: ts(NOW - 1) },
  },
}

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

describe('ownerMfaBindingValid', () => {
  test('a live, confirmed binding for this sign-in passes', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(true))
  test('no mfa_sid (password / Google / phone sign-in, same second) fails', () => {
    for (const p of ['password', 'google.com', 'phone']) {
      expect(ownerMfaBindingValid(DATA, tok(1000, {}, p), NOW)).toBe(false)
    }
  })
  test('a quick-login custom token (no mfa_sid) fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000), NOW)).toBe(false))
  test('mfa_sid on a non-custom provider fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000, { mfa_sid: 'SID_LIVE' }, 'password'), NOW)).toBe(false))
  test('an unknown sid fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000, { mfa_sid: 'NOPE' }), NOW)).toBe(false))
  test('minted but unconfirmed fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000, { mfa_sid: 'SID_MINTED' }), NOW)).toBe(false))
  test('a replayed redemption (different auth_time) fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1001, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(false))
  test('an expired binding fails', () =>
    expect(ownerMfaBindingValid(DATA, tok(1000, { mfa_sid: 'SID_EXPIRED' }), NOW)).toBe(false))
  test('no document / no token fails', () => {
    expect(ownerMfaBindingValid(undefined, tok(1000, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(false)
    expect(ownerMfaBindingValid(DATA, undefined, NOW)).toBe(false)
  })
})

describe('ownerMfaVerified reads ownerMfaSessions/{uid}', () => {
  const db = fakeDb({ ownerMfaSessions: { own1: DATA } })
  test('bound → true', async () => expect(await ownerMfaVerified(db, 'own1', tok(1000, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(true))
  test('another Owner\'s document is not consulted → false', async () =>
    expect(await ownerMfaVerified(db, 'own2', tok(1000, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(false))
  test('no mfa_sid → false without a read', async () =>
    expect(await ownerMfaVerified(fakeDb('throw'), 'own1', tok(1000), NOW)).toBe(false))
  test('an unreadable document fails closed', async () =>
    expect(await ownerMfaVerified(fakeDb('throw'), 'own1', tok(1000, { mfa_sid: 'SID_LIVE' }), NOW)).toBe(false))
})

describe('backfillPublicProfiles enforces it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'profiles.ts'), 'utf8')
  const body = src.slice(src.indexOf('export const backfillPublicProfiles'))
  test('checks the role, then the MFA binding, before any write', () => {
    const role = body.indexOf('!== OWNER_ROLE')
    const mfa = body.indexOf('ownerMfaVerified(db, uid, context.auth?.token')
    const firstWrite = body.indexOf('db.batch()')
    expect(role > 0 && mfa > role && firstWrite > mfa).toBe(true)
  })
})

describe('the Storage-claim trigger never persists mfa_sid', () => {
  function makeAuth(initial) {
    const users = new Map(Object.entries(initial))
    return {
      users,
      async getClaims(uid) { return users.has(uid) ? { ...users.get(uid) } : null },
      async setClaims(uid, claims) { users.set(uid, { ...claims }) },
    }
  }
  test('setting a partner claim drops an mfa_sid that somehow got onto the account', async () => {
    const auth = makeAuth({ u: { mfa_sid: 'leaked', other: 1 } })
    await syncClaim('u', { role: 'agency', agencyId: 'AG7', isActive: true }, auth)
    const claims = auth.users.get('u')
    expect('mfa_sid' in claims).toBe(false)
    expect(claims.other).toBe(1)
    expect(claims.role).toBe('agency')
  })
})

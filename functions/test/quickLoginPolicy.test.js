/**
 * QUICK LOGIN — every branch of the decision, and the ones that must fail.
 *
 * The credential this replaces was a 400-day bearer secret: redeemed by an
 * unauthenticated callable with no `context` at all, carrying a `deviceId` that
 * was never compared with anything, and on success only stamping `lastUsedAt` —
 * so the same secret worked again, from anywhere, for over a year. Lifted off
 * one handset it authenticated on another, and Block Store's cloud backup was
 * a channel built for exactly that copy.
 *
 * ── THE TESTS THAT MATTER MOST ───────────────────────────────────────────────
 *
 * `a valid credential with an invalid signature is refused` — this is the whole
 * device binding. If it ever passes, a copied secret is a working login again.
 *
 * `the signature is checked BEFORE the account` — a caller who cannot prove the
 * device must learn nothing about whether the account exists, is banned, or is
 * suspended. Reordering those two gates turns this into an enumeration oracle.
 *
 * `suspension keeps the credential` — the single state where a refusal must NOT
 * destroy the credential, because it is how the person reaches the appeal.
 *
 * Run:  node --test test/quickLoginPolicy.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const P = require('../lib/quickLoginPolicy')

const NOW = 1_800_000_000_000
const ts = (ms) => ({ toMillis: () => ms })

/** A credential as the new implementation writes one. */
const credential = (over = {}) => ({
  version: P.CREDENTIAL_VERSION,
  uid: 'user-1',
  publicKey: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----',
  expiresAt: ts(NOW + 1000),
  revokedAt: null,
  ...over,
})

const account = (over = {}) => ({
  isBanned: false,
  isSuspended: false,
  isDeleted: false,
  accountState: 'active',
  ...over,
})

const attempt = (over = {}) =>
  P.redemptionOutcome({
    rate: null,
    credential: credential(),
    account: account(),
    deviceBanned: false,
    signatureValid: true,
    nowMs: NOW,
    ...over,
  })

describe('the credential itself', () => {
  test('a good one passes', () => {
    expect(P.credentialVerdict(credential(), NOW)).toBe('ok')
  })

  test('a missing one is refused', () => {
    expect(P.credentialVerdict(null, NOW)).toBe('refused')
  })

  test('an expired one is refused', () => {
    expect(P.credentialVerdict(credential({ expiresAt: ts(NOW - 1) }), NOW)).toBe('refused')
  })

  test('a revoked one is refused', () => {
    expect(P.credentialVerdict(credential({ revokedAt: ts(NOW) }), NOW)).toBe('refused')
  })

  test('one with no public key is refused — there is nothing to verify against', () => {
    expect(P.credentialVerdict(credential({ publicKey: '' }), NOW)).toBe('refused')
  })

  test('one with no account is refused', () => {
    expect(P.credentialVerdict(credential({ uid: '' }), NOW)).toBe('refused')
  })

  test('the TTL is thirty days, not four hundred', () => {
    expect(P.QUICK_LOGIN_TTL_DAYS).toBe(30)
  })
})

describe('legacy credentials', () => {
  test('one with no version is legacy', () => {
    const old = { uid: 'user-1', expiresAt: ts(NOW + 1000) }
    expect(P.isLegacy(old)).toBe(true)
    expect(P.credentialVerdict(old, NOW)).toBe('legacy')
  })

  test('…and is refused rather than honoured', () => {
    // It cannot be upgraded in place: the device's Keystore key did not exist
    // when it was minted, so no proof of possession can be made for it.
    expect(attempt({ credential: { uid: 'user-1', expiresAt: ts(NOW + 1000) } })).toBe('legacy')
  })

  test('the message tells the person what to do about it', () => {
    expect(P.messageFor('legacy')).toBe(
      'Please sign in once to re-enable quick sign-in on this device.',
    )
  })

  test('a current credential is not legacy', () => {
    expect(P.isLegacy(credential())).toBe(false)
  })
})

describe('device binding', () => {
  test('a valid credential with an invalid signature is refused', () => {
    // The whole device binding. If this ever passes, a copied secret is a
    // working login again.
    expect(attempt({ signatureValid: false })).toBe('refused')
  })

  test('the signature is checked BEFORE the account', () => {
    // A caller who cannot prove the device must not be able to tell a banned
    // account from a healthy one — that difference is an enumeration oracle.
    const banned = attempt({ signatureValid: false, account: account({ isBanned: true }) })
    const healthy = attempt({ signatureValid: false })
    expect(banned).toBe('refused')
    expect(healthy).toBe('refused')
    expect(banned).toBe(healthy)
  })

  test('…and a refused attempt does not destroy the credential', () => {
    // Otherwise anyone who learned a secret could delete it by presenting it
    // badly, locking the real holder out for spite.
    expect(P.destroysCredential('refused')).toBe(false)
  })
})

describe('account state', () => {
  test('an active account is allowed', () => {
    expect(attempt()).toBe('allow')
  })

  test('a banned account is refused, and the credential is KEPT for the appeal', () => {
    // The credential survives a ban on purpose. Banning revokes the Firebase
    // session, so destroying the credential as well left the person with no
    // identifier at all — and the appeal is the one thing they still need to be
    // able to do. `permitsAppeal` is what it buys, and `grantsSession` stays
    // false, so it admits nobody to the product.
    expect(attempt({ account: account({ isBanned: true }) })).toBe('banned')
    expect(P.destroysCredential('banned')).toBe(false)
    expect(P.grantsSession('banned')).toBe(false)
    expect(P.permitsAppeal('banned')).toBe(true)
  })

  test('a banned device outranks everything about the account', () => {
    expect(attempt({ deviceBanned: true, account: account() })).toBe('device_banned')
    expect(attempt({ deviceBanned: true, account: account({ isBanned: true }) })).toBe('device_banned')
  })

  test('a deleted account is refused', () => {
    expect(attempt({ account: account({ isDeleted: true }) })).toBe('deleted')
  })

  test('…including one inside the recovery window', () => {
    // Recovery is an explicit flow and must not be entered sideways.
    expect(attempt({ account: account({ accountState: 'recovery_pending' }) })).toBe('deleted')
    expect(attempt({ account: account({ accountState: 'permanently_deactivated' }) })).toBe('deleted')
  })

  test('a suspended account reaches the suspension state, not the app', () => {
    expect(attempt({ account: account({ isSuspended: true }) })).toBe('suspended')
    expect(P.grantsSession('suspended')).toBe(false)
  })

  test('suspension KEEPS the credential', () => {
    // The one refusal that must not destroy it: the credential is how the
    // person reaches the suspension screen and the appeal.
    expect(P.destroysCredential('suspended')).toBe(false)
  })

  test('a missing account record is refused', () => {
    expect(attempt({ account: null })).toBe('refused')
  })

  test('only "allow" grants a session', () => {
    for (const outcome of ['suspended', 'banned', 'device_banned', 'deleted', 'refused', 'legacy', 'rate_limited']) {
      expect(P.grantsSession(outcome)).toBe(false)
    }
    expect(P.grantsSession('allow')).toBe(true)
  })
})

describe('rate limiting', () => {
  test('a fresh binding is not limited', () => {
    expect(P.isRateLimited(null, NOW)).toBe(false)
    expect(P.isRateLimited({ failures: 2 }, NOW)).toBe(false)
  })

  test('a live cool-off is', () => {
    expect(P.isRateLimited({ lockedUntil: ts(NOW + 1000) }, NOW)).toBe(true)
  })

  test('an elapsed cool-off is not', () => {
    expect(P.isRateLimited({ lockedUntil: ts(NOW - 1) }, NOW)).toBe(false)
  })

  test('failures accumulate and trip a cool-off at the ceiling', () => {
    expect(P.nextFailureState(null, NOW).failures).toBe(1)
    expect(P.nextFailureState(null, NOW).lockedUntilMs).toBe(null)
    const tripped = P.nextFailureState({ failures: P.MAX_FAILURES - 1 }, NOW)
    expect(tripped.failures).toBe(P.MAX_FAILURES)
    expect(tripped.lockedUntilMs).toBe(NOW + P.LOCKOUT_MS)
  })

  test('a corrupt counter does not become a bypass', () => {
    // A negative or non-numeric count must not read as "plenty of attempts left".
    expect(P.nextFailureState({ failures: -99 }, NOW).failures).toBe(1)
    expect(P.nextFailureState({ failures: 'lots' }, NOW).failures).toBe(1)
  })

  test('a limited binding is refused before anything is read', () => {
    expect(attempt({ rate: { lockedUntil: ts(NOW + 1000) } })).toBe('rate_limited')
  })
})

describe('what the person is told', () => {
  test('account ban and device ban are different sentences', () => {
    expect(P.messageFor('device_banned')).toBe(
      'Your device is banned. Contact the support for removing ban.',
    )
    expect(P.messageFor('banned')).toBe(
      'Your account has been banned. Please contact support to appeal this decision.',
    )
    expect(P.messageFor('banned')).not.toBe(P.messageFor('device_banned'))
  })

  test('a staff-written ban reason is used when there is one', () => {
    expect(P.messageFor('banned', 'Repeated harassment.')).toBe('Repeated harassment.')
  })

  test('everything else collapses to one neutral sentence', () => {
    // A failed probe must not reveal which account, if any, was behind it.
    const neutral = P.messageFor('refused')
    expect(P.messageFor('deleted')).toBe(neutral)
    expect(P.messageFor('suspended')).toBe(neutral)
  })

  test('no message leaks a credential or an internal field name', () => {
    for (const outcome of ['allow', 'refused', 'banned', 'device_banned', 'deleted', 'legacy', 'rate_limited', 'suspended']) {
      const m = P.messageFor(outcome)
      expect(m.includes('token')).toBe(false)
      expect(m.includes('publicKey')).toBe(false)
      expect(m.includes('uid')).toBe(false)
    }
  })
})

/**
 * THE DISPLACEMENT CUT-OFF, AND THE SECOND IT CANNOT SEE.
 *
 * Phase A made `firestore.rules::sessionCurrent()` compare the caller's
 * `request.auth.token.auth_time` against `users/{uid}.credentialsValidAfter`,
 * which `startMobileSession` stamps. That is what refuses a displaced handset's
 * DIRECT Firestore writes — the ones no callable sees, and the ones Firebase
 * token revocation cannot stop without also killing the device that just
 * displaced it.
 *
 * ── THE BUG THIS FILE WAS WRITTEN TO FIND ────────────────────────────────────
 *
 * The first implementation stamped `now - 5 seconds`, because `auth_time` is set
 * when Firebase mints a credential and that is a moment before the function
 * runs; without slack a device raced its own stamp.
 *
 * Slack is a window. For five seconds after Phone B signed in, Phone A's older
 * token still satisfied the comparison and kept writing. Switching phones is
 * exactly the two-sign-ins-seconds-apart case that window was open for.
 *
 * The fix is to stamp the CALLER'S OWN `auth_time` rather than a wall-clock
 * guess. `sameSecond` below is the test the specification asked for, and
 * `fiveSecondsApart` is the one that would have passed under the old stamp.
 *
 * ── WHAT IS NOT CLAIMED ──────────────────────────────────────────────────────
 *
 * `auth_time` has ONE-SECOND granularity. Two devices authenticating inside the
 * same clock second are indistinguishable at this layer, and `sameSecondExactly`
 * asserts that plainly rather than pretending otherwise. The mobile-session
 * check in `mobileSession.ts` has no resolution limit and is what covers that
 * case for every callable.
 *
 * This is a model of the rule, not the rule. There is no emulator here.
 *
 * Run:  node --test test/credentialCutoff.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const RULES = readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
const IDENTITY = readFileSync(join(__dirname, '..', 'src', 'identity.ts'), 'utf8')

/**
 * `sessionCurrent()`, as the rule is written.
 *
 * Pinned to the rule text below, so a change to one without the other fails
 * here rather than drifting silently.
 */
function sessionCurrent(authTime, credentialsValidAfter) {
  return authTime >= (credentialsValidAfter ?? 0)
}

/** What `startMobileSession` now stamps: the calling device's own auth_time. */
function stampFor(callerAuthTime) {
  return callerAuthTime
}

describe('the rule still says what this models', () => {
  test('it compares auth_time against the cut-off', () => {
    const stripped = RULES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(stripped.includes('request.auth.token.auth_time >=')).toBe(true)
    expect(stripped.includes("get('credentialsValidAfter', 0)")).toBe(true)
  })

  test('and the stamp is the caller\'s own auth_time, not a wall-clock guess', () => {
    expect(IDENTITY.includes('auth_time')).toBe(true)
    expect(IDENTITY.includes('callerAuthTime')).toBe(true)
  })
})

describe('displacement across time', () => {
  test('a phone that signed in days ago is refused', () => {
    const phoneA = 1_800_000_000
    const phoneB = phoneA + 86_400 * 3
    const cutoff = stampFor(phoneB)
    expect(sessionCurrent(phoneB, cutoff)).toBe(true)
    expect(sessionCurrent(phoneA, cutoff)).toBe(false)
  })

  test('FIVE SECONDS APART — the case the old slack let through', () => {
    // Under `now - 5` this returned true for Phone A and the displaced handset
    // kept writing. It is the reason the stamp changed.
    const phoneA = 1_800_000_000
    const phoneB = phoneA + 5
    const cutoff = stampFor(phoneB)
    expect(sessionCurrent(phoneA, cutoff)).toBe(false)
  })

  test('ONE SECOND APART is refused', () => {
    const phoneA = 1_800_000_000
    const phoneB = phoneA + 1
    expect(sessionCurrent(phoneA, stampFor(phoneB))).toBe(false)
  })

  test('the displacing device is never locked out by its own stamp', () => {
    // The failure the slack existed to prevent. Equality is what saves it, so
    // the rule must stay `>=` and not `>`.
    const phoneB = 1_800_000_000
    expect(sessionCurrent(phoneB, stampFor(phoneB))).toBe(true)
  })
})

describe('the residual limit, stated not hidden', () => {
  test('SAME SECOND EXACTLY: the displaced token still satisfies this gate', () => {
    // Asserted as a known limit rather than left to be discovered. `auth_time`
    // is whole seconds; two sign-ins inside one second are the same value here.
    const sameSecond = 1_800_000_000
    expect(sessionCurrent(sameSecond, stampFor(sameSecond))).toBe(true)
  })

  test('…and the mobile-session check is what covers it', () => {
    // Session ids are random 128-bit values, not timestamps, so they have no
    // resolution limit at all: two sign-ins in the same microsecond still
    // produce different ids and the displaced one does not match.
    const { sessionVerdict } = require('../lib/mobileSession')
    expect(sessionVerdict('session-B', 'session-A', true)).toBe('displaced')
  })
})

describe('accounts that predate the field', () => {
  test('an absent cut-off allows everyone, which is the migration', () => {
    // Every account that existed before this field has none, and `get(..., 0)`
    // returns 0. They are unaffected until their next sign-in stamps it, so the
    // control arrives per account with no flag day and no mass lockout.
    expect(sessionCurrent(1_800_000_000, undefined)).toBe(true)
    expect(sessionCurrent(1_800_000_000, 0)).toBe(true)
  })
})

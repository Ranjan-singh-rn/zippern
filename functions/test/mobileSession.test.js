/**
 * ONE ACTIVE MOBILE SESSION — the decision, exercised where it is made.
 *
 * `users/{uid}.activeMobileSession.sessionId` was written by the server and
 * compared only by the Android client: its own splash, its own listener. A
 * patched build that ignored the listener kept full access on the displaced
 * handset, because nothing on this side ever asked.
 *
 * `sessionVerdict` is the whole of that decision, split out from the Firestore
 * read so every branch can be run here without an initialised Firebase app.
 *
 * ── THE TEST THAT MATTERS MOST ──────────────────────────────────────────────
 *
 * `a wrong id is refused even during rollout`. The tolerance that lets today's
 * app builds keep working is for a session id that is ABSENT, and for nothing
 * else. A client that presents the wrong one is making a claim, and a claim is
 * checked whatever the rollout flag says. If that ever stops being true, the
 * rollout window becomes a bypass.
 *
 * Run:  node --test test/mobileSession.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const {
  sessionVerdict,
  presentedSessionId,
  SESSION_DISPLACED,
  DISPLACED_MESSAGE,
} = require('../lib/mobileSession')

describe('the verdict, while enforcing', () => {
  const enforcing = true

  test('the device holding the active session proceeds', () => {
    expect(sessionVerdict('sess-abc', 'sess-abc', enforcing)).toBe('ok')
  })

  test('a device holding a DIFFERENT session is displaced', () => {
    expect(sessionVerdict('sess-new', 'sess-old', enforcing)).toBe('displaced')
  })

  test('presenting an id when the account has none on record is displaced', () => {
    // A clean sign-out clears the field. An id presented afterwards matches
    // nothing, and "matches nothing" is not a reason to let it through.
    expect(sessionVerdict('', 'sess-old', enforcing)).toBe('displaced')
  })

  test('presenting nothing is refused', () => {
    expect(sessionVerdict('sess-abc', '', enforcing)).toBe('missing_refused')
  })
})

describe('the verdict, during rollout', () => {
  const enforcing = false

  test('presenting nothing is tolerated, which is what keeps today\'s builds working', () => {
    expect(sessionVerdict('sess-abc', '', enforcing)).toBe('missing_tolerated')
  })

  test('a WRONG id is refused even during rollout', () => {
    // The guard that has to survive this file. Tolerance is for absence only.
    expect(sessionVerdict('sess-new', 'sess-old', enforcing)).toBe('displaced')
  })

  test('…and so is an id against an empty record', () => {
    expect(sessionVerdict('', 'sess-old', enforcing)).toBe('displaced')
  })

  test('a matching id still proceeds', () => {
    expect(sessionVerdict('sess-abc', 'sess-abc', enforcing)).toBe('ok')
  })
})

describe('reading what the caller presented', () => {
  test('a string is taken and trimmed', () => {
    expect(presentedSessionId({ sessionId: '  sess-abc  ' })).toBe('sess-abc')
  })

  test('absent, null and undefined all read as absent', () => {
    expect(presentedSessionId({})).toBe('')
    expect(presentedSessionId(null)).toBe('')
    expect(presentedSessionId(undefined)).toBe('')
    expect(presentedSessionId({ sessionId: null })).toBe('')
  })

  test('a non-string reads as absent rather than being coerced', () => {
    // `String(12345)` would have produced a plausible-looking id out of a
    // number, and `String({})` an "[object Object]" that could be compared.
    expect(presentedSessionId({ sessionId: 12345 })).toBe('')
    expect(presentedSessionId({ sessionId: {} })).toBe('')
    expect(presentedSessionId({ sessionId: ['a'] })).toBe('')
  })

  test('an over-long value is cut rather than carried', () => {
    expect(presentedSessionId({ sessionId: 'x'.repeat(500) }).length).toBe(128)
  })
})

describe('what the displaced device is told', () => {
  test('a code it can branch on', () => {
    expect(SESSION_DISPLACED).toBe('SESSION_DISPLACED')
  })

  test('and a sentence that says what actually happened', () => {
    // Not "session expired". The person did not time out; somebody signed in
    // on another phone, and those need different answers on screen.
    expect(DISPLACED_MESSAGE).toBe('Your account was signed in on another device.')
    expect(DISPLACED_MESSAGE.toLowerCase().includes('expired')).toBe(false)
  })
})

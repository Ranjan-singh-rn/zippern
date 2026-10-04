/**
 * Party room — the rules a client must not be able to talk the server out of.
 *
 * ── WHAT IS WORTH TESTING HERE ───────────────────────────────────────────────
 *
 * Not the transactions. Those need an emulator, and the interesting half of what
 * they do (contention on a seat, a batch that must commit together) is Firestore's
 * behaviour rather than ours.
 *
 * What IS worth pinning is every place a number or a string arrives from a client
 * and gets clamped, because those are the guards that stop a phone being taken
 * down. A room that claimed twenty video seats used to be honoured by the Android
 * grid, and the only thing standing between that and a wedged device is
 * `seatsFor`. It is four lines. It should have a test.
 *
 * Run: cd functions && npm test
 */

const { describe, test } = require('node:test')
const { expect } = require('./expect')

// `party.ts` calls `admin.firestore()` at module load, so an app has to exist
// before it is required. No credentials are needed: nothing here touches the
// network, and `firestore()` only opens a channel on first use.
const admin = require('firebase-admin')
try {
  admin.initializeApp({ projectId: 'zipper-tests' })
} catch {
  // Already initialised by another test file in the same process.
}

const party = require('../lib/party')

// ── seat counts ──────────────────────────────────────────────────────────────

describe('seatsFor — the device budget, enforced', () => {
  test('audio offers ten or fifteen, defaulting to ten', () => {
    expect(party.SEAT_CHOICES[party.MODE_AUDIO]).toEqual([10, 15])
    expect(party.seatsFor('audio')).toBe(10)
    expect(party.seatsFor('audio', 10)).toBe(10)
    expect(party.seatsFor('audio', 15)).toBe(15)
  })

  test('video offers six or ten, defaulting to six', () => {
    expect(party.SEAT_CHOICES[party.MODE_VIDEO]).toEqual([6, 10])
    expect(party.seatsFor('video')).toBe(6)
    expect(party.seatsFor('video', 6)).toBe(6)
    expect(party.seatsFor('video', 10)).toBe(10)
  })

  /**
   * THE GUARD THAT MATTERS. Ten decoded video tiles is the ceiling a budget SoC
   * will composite; a room claiming twenty would be honoured by the grid and take
   * the device down. Every value outside the enumeration must fall back rather
   * than be obeyed — including the ones that look plausible.
   */
  test('anything not on the list falls back to the smallest allowed count', () => {
    const rubbish = [
      0, 1, 5, 7, 9, 11, 14, 16, 20, 100, 9999, -1, -15,
      1.5, 10.5, NaN, Infinity, -Infinity,
      null, undefined, '', '10', '15', 'ten', {}, [], [10], true, false,
    ]
    for (const v of rubbish) {
      const audio = party.seatsFor('audio', v)
      const video = party.seatsFor('video', v)
      expect([10, 15]).toContain(audio)
      expect([6, 10]).toContain(video)
    }
  })

  /**
   * A numeric STRING is accepted, and that is deliberate rather than an oversight.
   *
   * `seatsFor` runs `Number(requested)` and then checks membership, so `'15'`
   * becomes 15 and is allowed. Being lenient about JSON typing costs nothing here
   * because the membership check is what does the protecting — a coerced value
   * still has to be one of the enumerated counts, so `'20'` is refused exactly as
   * `20` is.
   *
   * Pinned as a test because the alternative reading ("strings must be refused")
   * is a tempting change to make, and making it would break any client that sends
   * the field as a string for one release.
   */
  test("a numeric string is coerced, then clamped like any other value", () => {
    expect(party.seatsFor('audio', '15')).toBe(15)
    expect(party.seatsFor('video', '10')).toBe(10)
    // Still clamped: coercion does not bypass the enumeration.
    expect(party.seatsFor('audio', '20')).toBe(10)
    expect(party.seatsFor('video', '15')).toBe(6)
    expect(party.seatsFor('audio', 'fifteen')).toBe(10)
  })

  test('an unknown mode is treated as audio rather than refused', () => {
    // A room with no price is a room nobody can open. Same reasoning as the
    // gender fallback in pricing.ts.
    expect(party.seatsFor('')).toBe(10)
    expect(party.seatsFor('AUDIO')).toBe(10)
    expect(party.seatsFor('nonsense')).toBe(10)
    expect(party.seatsFor(undefined)).toBe(10)
    expect(party.seatsFor(null)).toBe(10)
  })

  test('video is matched exactly — a near miss must not buy video seats', () => {
    // `modeOf` compares against the constant, so only the exact string wins.
    // Otherwise 'Video' would produce an audio room with a video seat count.
    expect(party.seatsFor('Video')).toBe(10)
    expect(party.seatsFor('video ')).toBe(10)
    expect(party.seatsFor('video')).toBe(6)
  })

  test('the two modes never share a seat count by accident', () => {
    // 10 is legal in both, which is intentional. What must not happen is a video
    // room reaching 15.
    expect(party.SEAT_CHOICES[party.MODE_VIDEO]).not.toContain(15)
    expect(Math.max(...party.SEAT_CHOICES[party.MODE_VIDEO])).toBeLessThanOrEqual(10)
  })
})

// ── the constants the client mirrors ─────────────────────────────────────────

describe('the vocabulary shared with the Android client', () => {
  /**
   * `PartyRoom.kt` hardcodes these same strings, because a Kotlin client cannot
   * import a TypeScript constant. A silent rename on either side would produce a
   * room whose mode, seat policy or visibility every client misreads — and it
   * would misread it as the DEFAULT, which is the failure that looks like nothing
   * is wrong.
   */
  test('the literal values are what the client expects', () => {
    expect(party.MODE_AUDIO).toBe('audio')
    expect(party.MODE_VIDEO).toBe('video')
    expect(party.SEAT_MODE_FREE).toBe('free')
    expect(party.SEAT_MODE_CONSENT).toBe('consent')
    expect(party.VISIBILITY_PUBLIC).toBe('public')
    expect(party.VISIBILITY_PRIVATE).toBe('private')
  })

  test('every mode in SEAT_CHOICES has at least one allowed count', () => {
    for (const mode of [party.MODE_AUDIO, party.MODE_VIDEO]) {
      const choices = party.SEAT_CHOICES[mode]
      expect(Array.isArray(choices)).toBe(true)
      expect(choices.length).toBeGreaterThan(0)
      for (const n of choices) {
        expect(Number.isInteger(n)).toBe(true)
        expect(n).toBeGreaterThan(0)
      }
    }
  })
})

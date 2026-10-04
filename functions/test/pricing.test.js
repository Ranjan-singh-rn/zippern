/**
 * Call pricing — every cell of the split table, and every who-pays case.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The split was handed over as thirty-six worked examples. Thirty-six examples
 * checked by hand, once, is not a test — it is a moment of confidence that
 * decays the first time somebody edits the table. And the failure mode here is
 * the quiet kind: a wrong cell does not throw, it just underpays one gender of
 * host on every call they ever take. Nobody files that bug. They leave.
 *
 * So this walks all thirty-six, plus the cases around them that turned out to
 * be where the real bugs were living: who is billed when a host dials a user,
 * what an unverified host is allowed to charge, and whether ceiling division
 * ever rounds a diamond away from the earner.
 *
 * Run: cd functions && npm test
 */

const { describe, test } = require('node:test')
const { expect } = require('./expect')
const { genderOf, earnerPct, rateFor } = require('../lib/pricing')

// ── fixtures ─────────────────────────────────────────────────────────────────

const GENDERS = ['male', 'female', 'transgender']

/** The table as the product specified it. Duplicated on purpose: if this and
 *  SPLIT_DEFAULTS are edited together by accident, the test still fails. */
const SPEC = {
  male:        { male: 30, female: 50, transgender: 40 },
  female:      { male: 40, female: 30, transgender: 40 },
  transgender: { male: 40, female: 40, transgender: 40 },
}

const user = (gender, extra = {}) => ({ gender, isHost: false, ...extra })
const host = (gender, extra = {}) => ({
  gender,
  isHost: true,
  isVerifiedHost: true,
  callRateBeans: 375,
  ...extra,
})

const CFG = { callRateBeansPerMin: 375, userCallRatePerMin: 1600 }

// ── genderOf ─────────────────────────────────────────────────────────────────

describe('genderOf', () => {
  test('reads the three known values, case and whitespace insensitive', () => {
    expect(genderOf({ gender: 'male' })).toBe('male')
    expect(genderOf({ gender: 'FEMALE' })).toBe('female')
    expect(genderOf({ gender: '  Male  ' })).toBe('male')
    expect(genderOf({ gender: 'transgender' })).toBe('transgender')
  })

  /**
   * The decision the user made when I asked: an account with no gender is
   * priced as transgender. It matters that this NEVER throws — a pairing with
   * no price is a paying customer turned away mid-spend.
   */
  test('anything unrecorded falls to transgender rather than failing', () => {
    expect(genderOf({})).toBe('transgender')
    expect(genderOf({ gender: null })).toBe('transgender')
    expect(genderOf({ gender: '' })).toBe('transgender')
    expect(genderOf({ gender: 'Other' })).toBe('transgender')
    expect(genderOf({ gender: 42 })).toBe('transgender')
    expect(genderOf({ gender: undefined })).toBe('transgender')
  })
})

// ── the 3x3 table ────────────────────────────────────────────────────────────

describe('earnerPct — the specified table', () => {
  for (const payer of GENDERS) {
    for (const earner of GENDERS) {
      test(`${payer} pays ${earner} → ${SPEC[payer][earner]}%`, () => {
        expect(earnerPct({}, payer, earner)).toBe(SPEC[payer][earner])
      })
    }
  }

  test('the table is not symmetric — that is the whole point', () => {
    // The old three-number config could not express this pair, which is why
    // it was replaced rather than extended.
    expect(earnerPct({}, 'male', 'female')).toBe(50)
    expect(earnerPct({}, 'female', 'male')).toBe(40)
  })

  test('a CRM override is honoured', () => {
    const cfg = { callSplitMatrix: { male: { female: 55 } } }
    expect(earnerPct(cfg, 'male', 'female')).toBe(55)
    // and does not leak into cells it did not set
    expect(earnerPct(cfg, 'male', 'male')).toBe(30)
    expect(earnerPct(cfg, 'female', 'male')).toBe(40)
  })

  /**
   * A zero here would hand the whole call to the platform and pay the earner
   * nothing. Of every possible bad config value, that is the one that would
   * take longest to notice, so it must fall back rather than be obeyed.
   */
  test('a nonsense override falls back to the spec instead of to zero', () => {
    const bad = [0, -5, 101, NaN, Infinity, null, undefined, '50', {}, []]
    for (const v of bad) {
      const cfg = { callSplitMatrix: { male: { female: v } } }
      expect(earnerPct(cfg, 'male', 'female')).toBe(50)
    }
  })

  test('a fractional override is truncated, never rounded up', () => {
    expect(earnerPct({ callSplitMatrix: { male: { female: 50.9 } } }, 'male', 'female')).toBe(50)
  })

  test('a malformed matrix is survivable', () => {
    expect(earnerPct({ callSplitMatrix: null }, 'male', 'female')).toBe(50)
    expect(earnerPct({ callSplitMatrix: 'nonsense' }, 'male', 'female')).toBe(50)
    expect(earnerPct({ callSplitMatrix: { male: null } }, 'male', 'female')).toBe(50)
  })
})

// ── who pays ─────────────────────────────────────────────────────────────────

describe('rateFor — who pays', () => {
  /**
   * THE BUG THIS LOCKS DOWN. The old code derived the payer from `earnerUid`
   * in a way that billed the CALLER whenever the caller was a host — so a host
   * phoning a user was charged for the privilege of earning, and refused the
   * call outright for having an empty wallet.
   */
  test('host dials user → the USER pays, the HOST earns', () => {
    const r = rateFor(CFG, host('female'), user('male'))
    expect(r.payer).toBe('receiver')
    expect(r.earner).toBe('caller')
  })

  test('user dials host → the USER pays, the HOST earns', () => {
    const r = rateFor(CFG, user('male'), host('female'))
    expect(r.payer).toBe('caller')
    expect(r.earner).toBe('receiver')
  })

  test('the payer is never also the earner, in any pairing', () => {
    for (const a of GENDERS) {
      for (const b of GENDERS) {
        for (const aHost of [true, false]) {
          for (const bHost of [true, false]) {
            const mk = (g, isH) => (isH ? host(g) : user(g))
            const r = rateFor(CFG, mk(a, aHost), mk(b, bHost))
            expect(r.payer).not.toBe(r.earner)
          }
        }
      }
    }
  })

  test('two users → caller pays, receiver earns, at the flat rate', () => {
    const r = rateFor(CFG, user('male'), user('female'))
    expect(r.payer).toBe('caller')
    expect(r.earner).toBe('receiver')
    expect(r.perMin).toBe(1600)
  })

  test('two hosts → caller pays, receiver earns', () => {
    const r = rateFor(CFG, host('male'), host('female'))
    expect(r.payer).toBe('caller')
    expect(r.earner).toBe('receiver')
  })
})

// ── the two worked examples that look contradictory ───────────────────────────

describe('rateFor — the pair that made the rule hard to state', () => {
  test('female host calls male user → payer male, earner female → 50%', () => {
    expect(rateFor(CFG, host('female'), user('male')).pct).toBe(50)
  })

  test('male host calls female user → payer female, earner male → 40%', () => {
    expect(rateFor(CFG, host('male'), user('female')).pct).toBe(40)
  })
})

// ── the full matrix, both directions, both kinds ──────────────────────────────

describe('rateFor — all pairings agree with the table', () => {
  for (const callerG of GENDERS) {
    for (const receiverG of GENDERS) {
      for (const [label, caller, receiver] of [
        ['user→host', user(callerG), host(receiverG)],
        ['host→user', host(callerG), user(receiverG)],
        ['user→user', user(callerG), user(receiverG)],
        ['host→host', host(callerG), host(receiverG)],
      ]) {
        test(`${label} ${callerG}→${receiverG}`, () => {
          const r = rateFor(CFG, caller, receiver)
          const payerG   = r.payer === 'caller' ? callerG : receiverG
          const earnerG  = r.earner === 'caller' ? callerG : receiverG
          expect(r.pct).toBe(SPEC[payerG][earnerG])
        })
      }
    }
  }
})

// ── price derivation ─────────────────────────────────────────────────────────

describe('rateFor — the price follows the earner income', () => {
  test('price is income/pct, rounded UP so the earner is never short', () => {
    // 375 beans at 30% → 1250 exactly
    expect(rateFor(CFG, user('male'), host('male')).perMin).toBe(1250)
    // 375 at 50% → 750
    expect(rateFor(CFG, user('male'), host('female')).perMin).toBe(750)
    // 375 at 40% → 937.5 → 938, never 937
    expect(rateFor(CFG, user('female'), host('male')).perMin).toBe(938)
  })

  test('ceiling never favours the payer, across every cell', () => {
    for (const payer of GENDERS) {
      for (const earner of GENDERS) {
        const r = rateFor(CFG, user(payer), host(earner))
        // what the earner actually receives must cover the specified income
        expect(Math.floor((r.perMin * r.pct) / 100)).toBeGreaterThanOrEqual(375)
      }
    }
  })

  test("a verified host's own rate sets the price", () => {
    const r = rateFor(CFG, user('male'), host('female', { callRateBeans: 1000 }))
    expect(r.perMin).toBe(2000) // 1000 at 50%
  })

  /**
   * Without this, the cheapest way to make money here is to register a host
   * with someone else's photograph, set the rate to the ceiling, and never
   * complete verification. The badge gates featuring and payouts; this gates
   * price.
   */
  test('an unverified host earns the base rate, never their own', () => {
    const greedy = host('female', { isVerifiedHost: false, callRateBeans: 99999 })
    expect(rateFor(CFG, user('male'), greedy).perMin).toBe(750) // 375 at 50%
  })

  test('a missing rate falls back to the configured base', () => {
    const noRate = { gender: 'female', isHost: true, isVerifiedHost: true }
    expect(rateFor(CFG, user('male'), noRate).perMin).toBe(750)
  })

  test('a missing config still produces a usable price', () => {
    const r = rateFor({}, user('male'), host('female'))
    expect(r.perMin).toBeGreaterThan(0)
    expect(Number.isFinite(r.perMin)).toBe(true)
  })

  test('no pairing ever yields a zero, negative or non-finite price', () => {
    for (const a of GENDERS) {
      for (const b of GENDERS) {
        for (const aHost of [true, false]) {
          for (const bHost of [true, false]) {
            const mk = (g, isH) => (isH ? host(g) : user(g))
            const r = rateFor(CFG, mk(a, aHost), mk(b, bHost))
            expect(Number.isFinite(r.perMin)).toBe(true)
            expect(r.perMin).toBeGreaterThan(0)
            expect(r.pct).toBeGreaterThanOrEqual(1)
            expect(r.pct).toBeLessThanOrEqual(100)
          }
        }
      }
    }
  })
})

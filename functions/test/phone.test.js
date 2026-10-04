/**
 * PHONE NUMBERS AS IDENTITY.
 *
 * The key used to be the last TEN digits, so `+14155550100` and
 * `+914155550100` were one identity. Two people, two countries, one record —
 * and `bindVerifiedIdentity` looks an account up by that key and BLANKS its
 * `phoneKey`, `phoneNumber` and `email` when the holder is permanently
 * deactivated. A US sign-in could erase an Indian account's phone identity.
 *
 * Every test here is a pair of numbers that must stay apart, or a spelling of
 * one number that must still be recognised. The first group is the security
 * property; the second is the thing that breaks if you fix the first carelessly.
 *
 * Run:  node --test test/phone.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const {
  digitsOf,
  phoneE164Key,
  legacyPhoneKey,
  hasCountryCode,
  sameNumber,
  sameNumberStrict,
} = require('../lib/phone')

describe('two countries, same local digits', () => {
  const US = '+14155550100'
  const IN = '+914155550100'

  test('the old key made them one identity — this is the regression', () => {
    // Kept as a test rather than deleted: it states what the bug WAS, so the
    // next person to reach for `slice(-10)` can see what it cost.
    expect(legacyPhoneKey(US)).toBe(legacyPhoneKey(IN))
  })

  test('the canonical key keeps them apart', () => {
    expect(phoneE164Key(US)).not.toBe(phoneE164Key(IN))
    expect(phoneE164Key(US)).toBe('14155550100')
    expect(phoneE164Key(IN)).toBe('914155550100')
  })

  test('and they are not the same number, loosely or strictly', () => {
    expect(sameNumber(US, IN)).toBe(false)
    expect(sameNumberStrict(US, IN)).toBe(false)
  })

  test('a whole table of countries stays distinct', () => {
    const numbers = [
      '+14155550100',   // US
      '+914155550100',  // India
      '+444155550100',  // UK
      '+9714155550100', // UAE
      '+614155550100',  // Australia
      '+8614155550100', // China
    ]
    const keys = numbers.map(phoneE164Key)
    expect(new Set(keys).size).toBe(numbers.length)
    // And every pair, explicitly — a Set size can pass on a coincidence.
    for (let i = 0; i < numbers.length; i++) {
      for (let j = i + 1; j < numbers.length; j++) {
        expect(sameNumberStrict(numbers[i], numbers[j])).toBe(false)
      }
    }
  })
})

describe('one number, many spellings', () => {
  test('an Indian number keeps working however it is written', () => {
    const forms = ['+919876543210', '+91 98765 43210', '+91-98765-43210', '919876543210']
    for (const f of forms) expect(phoneE164Key(f)).toBe('919876543210')
  })

  test('a leading zero is a trunk prefix, not a country code', () => {
    // `098765 43210` is eleven digits and is how an Indian number is commonly
    // written down. Reading it as "already international" produced `+09876…`,
    // a number no country owns.
    expect(hasCountryCode('09876543210')).toBe(false)
    expect(hasCountryCode('9876543210')).toBe(false)
    expect(hasCountryCode('+919876543210')).toBe(true)
    expect(hasCountryCode('919876543210')).toBe(true)
  })

  test('a US number keeps working however it is written', () => {
    for (const f of ['+1 (415) 555-0100', '+14155550100', '14155550100']) {
      expect(phoneE164Key(f)).toBe('14155550100')
    }
  })

  test('nothing in, nothing out', () => {
    for (const empty of ['', null, undefined, '   ', 'not a number']) {
      expect(phoneE164Key(empty)).toBe('')
      expect(sameNumber(empty, '+919876543210')).toBe(false)
      expect(sameNumberStrict(empty, '+919876543210')).toBe(false)
    }
  })
})

describe('a bare national number, where the country is unknown', () => {
  test('matches the tail of a full number — loosely, on purpose', () => {
    /*
     * This is the tolerance `activateHost` needs: an agency types `9876543210`
     * into the CRM and the host arrives holding `+919876543210`. Refusing that
     * would mean no host could ever redeem a code.
     *
     * It is ambiguous by construction — the same bare number matches a `+1`
     * too — which is why the phone is never sufficient on its own there: the
     * email must match as well.
     */
    expect(sameNumber('9876543210', '+919876543210')).toBe(true)
    expect(sameNumber('4155550100', '+14155550100')).toBe(true)
    expect(sameNumber('4155550100', '+914155550100')).toBe(true)
  })

  test('but NOT strictly, which is what anything destructive uses', () => {
    // `bindVerifiedIdentity` releases another account's phone claim and blanks
    // its fields. An ambiguous match must never reach that.
    expect(sameNumberStrict('4155550100', '+14155550100')).toBe(false)
    expect(sameNumberStrict('4155550100', '+914155550100')).toBe(false)
  })

  test('a bare number does not match an unrelated full one', () => {
    expect(sameNumber('9876543210', '+14155550100')).toBe(false)
    expect(sameNumber('1234567890', '+919876543210')).toBe(false)
  })

  test('and the prefix in front of it has to be a plausible country code', () => {
    // Otherwise any long number ending in those digits would match.
    expect(sameNumber('5550100', '+1415555555550100')).toBe(false)
  })
})

describe('the properties that matter', () => {
  test('no two different E.164 numbers ever share a key', () => {
    const corpus = [
      '+919876543210', '+919876543211', '+14155550100', '+14155550101',
      '+447911123456', '+971501234567', '+8613800138000', '+5511999999999',
      '+2348012345678', '+6281234567890',
    ]
    const seen = new Map()
    for (const n of corpus) {
      const k = phoneE164Key(n)
      expect(seen.has(k)).toBe(false)
      seen.set(k, n)
    }
    expect(seen.size).toBe(corpus.length)
  })

  test('strict equality is reflexive and never ambiguous', () => {
    for (const n of ['+919876543210', '+14155550100', '9876543210']) {
      expect(sameNumberStrict(n, n)).toBe(true)
    }
  })

  test('digitsOf never returns a sign, space or bracket', () => {
    expect(digitsOf('+1 (415) 555-0100 ext. 9')).toBe('14155550100' + '9')
    expect(/^\d*$/.test(digitsOf('+91 98765 43210'))).toBe(true)
  })
})

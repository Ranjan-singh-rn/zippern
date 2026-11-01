/**
 * RC (confirmed) — "Permit another appeal after a decision only with new
 * evidence or a valid reason." The pure rule the device-key appeal path
 * (`quickLogin.ts`) applies, identical to backend `appeal_policy` and to the
 * `reappealOk` create rule in firestore.rules.
 *
 * Run:  node --test test/rcReappeal.test.js
 */

const { test, describe } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const { reappealProblem, REAPPEAL_REFUSAL } = require('../lib/appealIds')

describe('reappealProblem', () => {
  test('a first appeal is never refused by it', () => {
    expect(reappealProblem([], 'I was banned by mistake.')).toBe('')
  })
  test('repeating a decided statement (case and spacing ignored) is refused', () => {
    expect(reappealProblem(['I was banned by mistake.'], '  i was BANNED by   mistake. ')).toBe(REAPPEAL_REFUSAL)
  })
  test('a new reason is accepted', () => {
    expect(reappealProblem(['I was banned by mistake.'], 'Since the decision I found the recording.')).toBe('')
  })
  test('new evidence is accepted even with the same words', () => {
    expect(reappealProblem(['I was banned by mistake.'], 'I was banned by mistake.', 1)).toBe('')
  })
})

describe('the device-key appeal path applies it and has no automatic-id fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'quickLogin.ts'), 'utf8')
  test('the slot loop asks reappealProblem before writing a later slot', () => {
    expect(src.includes('reappealProblem(decided,')).toBe(true)
  })
  test('there is no write at an automatic id', () => {
    const loop = src.slice(src.indexOf('for (let slot = 1; slot <= MAX_APPEAL_SLOTS'))
    expect(loop.slice(0, 1500).includes("collection(APPEALS).doc()")).toBe(false)
  })
})

/**
 * A thirty-line `expect`, so the tests need no test framework.
 *
 * ── WHY NOT JEST ─────────────────────────────────────────────────────────────
 *
 * Jest is in `node_modules` (pulled in transitively) but its own resolver
 * cannot find `jest-circus/runner` under this install, and the fix is a
 * dependency bump on a package nothing else here uses. Node 22 ships a test
 * runner — `node --test` — which needs nothing, matches the `engines: node 22`
 * this project already declares, and will therefore also work on a fresh
 * checkout with no `npm install` at all.
 *
 * What it does not ship is an assertion style that reads like a sentence. So
 * this is that, and only the matchers these tests actually use. If a test needs
 * a matcher that is not here, add it here rather than reaching for a framework.
 */

const assert = require('node:assert/strict')

function expect(actual) {
  const api = {
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toBeTruthy: () => assert.ok(actual, `expected truthy, got ${format(actual)}`),
    toBeFalsy: () => assert.ok(!actual, `expected falsy, got ${format(actual)}`),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeUndefined: () => assert.strictEqual(actual, undefined),
    toBeGreaterThan: (e) => assert.ok(actual > e, `expected ${format(actual)} > ${format(e)}`),
    toBeGreaterThanOrEqual: (e) =>
      assert.ok(actual >= e, `expected ${format(actual)} >= ${format(e)}`),
    toBeLessThan: (e) => assert.ok(actual < e, `expected ${format(actual)} < ${format(e)}`),
    toBeLessThanOrEqual: (e) =>
      assert.ok(actual <= e, `expected ${format(actual)} <= ${format(e)}`),
    toContain: (e) =>
      assert.ok(
        actual != null && typeof actual.includes === 'function' && actual.includes(e),
        `expected ${format(actual)} to contain ${format(e)}`,
      ),
    toHaveLength: (e) =>
      assert.strictEqual(actual == null ? undefined : actual.length, e),
    toThrow: (match) => assert.throws(actual, match ? matcher(match) : undefined),
    /** Async: the promise must reject, optionally with a message that matches. */
    rejects: (match) => assert.rejects(actual, match ? matcher(match) : undefined),
  }
  api.not = {
    toBe: (e) => assert.notStrictEqual(actual, e),
    toEqual: (e) => assert.notDeepStrictEqual(actual, e),
    toContain: (e) =>
      assert.ok(
        !(actual != null && typeof actual.includes === 'function' && actual.includes(e)),
        `expected ${format(actual)} not to contain ${format(e)}`,
      ),
    toThrow: () => assert.doesNotThrow(actual),
  }
  return api
}

function matcher(m) {
  if (m instanceof RegExp) return (err) => m.test(String(err && err.message))
  if (typeof m === 'string') return (err) => String(err && err.message).includes(m)
  return m
}

function format(v) {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
  } catch {
    return '[unprintable]'
  }
}

module.exports = { expect }

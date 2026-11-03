/**
 * The local test copy's backend is http://127.0.0.1:8000. A service key may go
 * there over plain http only inside the Functions emulator; a deployed function
 * (no FUNCTIONS_EMULATOR) keeps refusing everything that is not https://.
 *
 * Run:  node --test test/emulatorLoopback.test.js   (after tsc)
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { isEmulatorLoopback } = require('../lib/emulatorLoopback')

const EMU = { FUNCTIONS_EMULATOR: 'true' }

test('inside the emulator: loopback http is allowed', () => {
  for (const base of ['http://127.0.0.1:8000', 'http://127.0.0.1:8000/', 'http://localhost:8000', 'http://127.0.0.1', 'HTTP://LOCALHOST:8000/api']) {
    assert.equal(isEmulatorLoopback(base, EMU), true, base)
  }
})

test('inside the emulator: anything else over http is still refused', () => {
  for (const base of ['http://10.0.2.2:8000', 'http://192.168.1.5:8000', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com:8000',
    'http://zipper-api.run.app', 'ftp://127.0.0.1', 'http://127.0.0.10:8000', '']) {
    assert.equal(isEmulatorLoopback(base, EMU), false, base)
  }
})

test('outside the emulator: nothing is allowed, loopback included', () => {
  for (const env of [{}, { FUNCTIONS_EMULATOR: 'false' }, { FUNCTIONS_EMULATOR: '1' }, { FUNCTIONS_EMULATOR: 'TRUE' }]) {
    assert.equal(isEmulatorLoopback('http://127.0.0.1:8000', env), false, JSON.stringify(env))
  }
})

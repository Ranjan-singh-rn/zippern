/**
 * THE DEVICE BINDING, AGAINST REAL CRYPTOGRAPHY.
 *
 * `quickLoginPolicy.test.js` exercises the decision tree with `signatureValid`
 * as a boolean. This file establishes that the boolean means what it claims: a
 * signature produced by one key does not verify against another.
 *
 * That is the entire transfer defence. The Android private key is generated
 * inside the Keystore and cannot be exported, so a secret copied to a second
 * handset — by cloud backup, by device transfer, by reading the file off a
 * rooted phone — arrives without the key that signs for it.
 *
 * ── THE TEST THAT MATTERS MOST ───────────────────────────────────────────────
 *
 * `a signature does not verify against a DIFFERENT key`. It stands in for the
 * copied-credential case, and if it ever passes the binding is decorative.
 *
 * Run:  node --test test/quickLoginSignature.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')

const { verifySignature } = require('../lib/quickLogin')

/** An EC P-256 pair, the shape the Android Keystore produces. */
function keypair() {
  return crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

function sign(privateKey, challenge) {
  return crypto
    .sign('sha256', Buffer.from(challenge, 'utf8'), { key: privateKey, dsaEncoding: 'der' })
    .toString('base64')
}

const CHALLENGE = 'IhAvZXhhbXBsZS1jaGFsbGVuZ2U'

describe('a genuine device', () => {
  test('its own signature verifies', () => {
    const device = keypair()
    expect(verifySignature(device.publicKey, CHALLENGE, sign(device.privateKey, CHALLENGE))).toBe(true)
  })

  test('…and keeps verifying across challenges', () => {
    const device = keypair()
    for (const c of ['a', 'b-longer-challenge', '0'.repeat(64)]) {
      expect(verifySignature(device.publicKey, c, sign(device.privateKey, c))).toBe(true)
    }
  })
})

describe('a copied credential', () => {
  test('a signature does not verify against a DIFFERENT key', () => {
    // The whole transfer defence. A secret restored onto a second handset
    // brings the bytes and not the Keystore key, so it signs nothing.
    const original = keypair()
    const other = keypair()
    const signature = sign(original.privateKey, CHALLENGE)
    expect(verifySignature(other.publicKey, CHALLENGE, signature)).toBe(false)
  })

  test('and a signature for one challenge does not serve another', () => {
    // Replay across challenges. The server issues a fresh nonce per attempt and
    // consumes it, so a captured signature is worth exactly one attempt that
    // has already happened.
    const device = keypair()
    const signature = sign(device.privateKey, CHALLENGE)
    expect(verifySignature(device.publicKey, 'a-different-challenge', signature)).toBe(false)
  })
})

describe('malformed input is refused, not thrown', () => {
  // A caller sending rubbish should get a refusal. Throwing here would turn a
  // bad request into a 500 and hand an attacker a way to tell inputs apart.
  const device = keypair()
  const good = sign(device.privateKey, CHALLENGE)

  test('an empty public key', () => {
    expect(verifySignature('', CHALLENGE, good)).toBe(false)
  })

  test('an empty challenge', () => {
    expect(verifySignature(device.publicKey, '', good)).toBe(false)
  })

  test('an empty signature', () => {
    expect(verifySignature(device.publicKey, CHALLENGE, '')).toBe(false)
  })

  test('a public key that is not a key', () => {
    expect(verifySignature('not a pem at all', CHALLENGE, good)).toBe(false)
  })

  test('a signature that is not base64', () => {
    expect(verifySignature(device.publicKey, CHALLENGE, '!!! not base64 !!!')).toBe(false)
  })

  test('a truncated signature', () => {
    expect(verifySignature(device.publicKey, CHALLENGE, good.slice(0, 10))).toBe(false)
  })

  test('null and undefined', () => {
    expect(verifySignature(null, CHALLENGE, good)).toBe(false)
    expect(verifySignature(device.publicKey, null, good)).toBe(false)
    expect(verifySignature(device.publicKey, CHALLENGE, undefined)).toBe(false)
  })
})

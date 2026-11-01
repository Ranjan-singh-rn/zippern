/**
 * AUTH-001 (Phase 1A) — the SHIPPED `claimGuestIdentity`, executed.
 *
 * `guestBinding.test.js` proves the decision table. This file proves the
 * wiring: that the callable feeds `callerUid` from the verified `context.auth`
 * (never from the request body), that the reverse uid→device index is written
 * and enforced inside the transaction, and that no custom token is ever minted
 * for an account the caller does not own.
 *
 * Firestore RULES are not exercised here (Admin SDK); see tests/firestore.rules.test.mjs.
 *
 * Run:  node --test test/guestBindingRuntime.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')
const admin = require('firebase-admin')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
let db = installFakeFirestore()

// Auth fake with per-uid provider data, so "upgraded" accounts can be modelled.
const providers = new Map()
let minted = []
function installAuth() {
  minted = []
  Object.defineProperty(admin, 'auth', {
    configurable: true, writable: true,
    value: () => ({
      createCustomToken: async (uid) => { minted.push(uid); return `token-${uid}` },
      getUser: async (uid) => ({ uid, providerData: (providers.get(uid) || []).map((p) => ({ providerId: p })) }),
      updateUser: async () => undefined,
      revokeRefreshTokens: async () => undefined,
    }),
  })
}
installAuth()

const ID = require('../lib/identity')
const claim = (data, auth) => ID.claimGuestIdentity.run(data, auth ? { auth: { uid: auth, token: {} } } : {})

const SECRET_A = 'a'.repeat(43)
const SECRET_B = 'b'.repeat(43)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

function reset() {
  // `identity.ts` captured the fake at require time; empty it rather than
  // installing a new one the module would never see.
  db._docs.clear()
  providers.clear()
  installAuth()
}

describe('AUTH-001 — claimGuestIdentity, executed', () => {
  beforeEach(reset)

  test('an unauthenticated caller naming a victim uid gets nothing and writes nothing', async () => {
    db.seed('users/VICTIM', { name: 'v', diamonds: 500 })
    const r = await claim({ deviceId: 'DEV-ATT', deviceSecret: SECRET_B, uid: 'VICTIM' })
    expect(r.status).toBe('not_owner')
    expect(db.read('guestDeviceBindings/DEV-ATT')).toBe(undefined)
    expect(db.read('guestUidBindings/VICTIM')).toBe(undefined)
    // The follow-up "question" from the same device finds nothing to hand over.
    const q = await claim({ deviceId: 'DEV-ATT', deviceSecret: SECRET_B })
    expect(q.status).toBe('no_guest')
    expect(minted).toEqual([])
  })

  test('a caller signed in as another account naming a victim uid is refused', async () => {
    const r = await claim({ deviceId: 'DEV-ATT', deviceSecret: SECRET_B, uid: 'VICTIM' }, 'ATTACKER')
    expect(r.status).toBe('not_owner')
    expect(minted).toEqual([])
  })

  test('a guest binds its OWN uid; the reverse index is written; it returns with the secret', async () => {
    const b = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    expect(b.status).toBe('bound')
    const binding = db.read('guestDeviceBindings/DEV-1')
    expect(binding.uid).toBe('G1')
    expect(binding.ownerVerified).toBe(true)
    expect(binding.secretHash).toBe(sha(SECRET_A))
    expect(db.read('guestUidBindings/G1').deviceId).toBe('DEV-1')
    // Signed out later: the device asks with its secret and gets its own guest back.
    const back = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(back.status).toBe('existing_guest')
    expect(back.uid).toBe('G1')
    expect(minted).toEqual(['G1'])
  })

  test('the same uid cannot be bound to a second device, even by its owner', async () => {
    await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    const r = await claim({ deviceId: 'DEV-2', deviceSecret: SECRET_B, uid: 'G1' }, 'G1')
    expect(r.status).toBe('bound_elsewhere')
    expect(db.read('guestDeviceBindings/DEV-2')).toBe(undefined)
  })

  test('a wrong secret on the bound device mints nothing', async () => {
    await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    minted = []
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_B })
    expect(r.status).toBe('unrecoverable')
    expect(minted).toEqual([])
  })

  test('Option B: an owner-proven binding re-opens the account after it adds an email', async () => {
    await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    db.seed('users/G1', { name: 'g' })
    providers.set('G1', ['password'])
    minted = []
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(r.status).toBe('existing_guest')
    expect(minted).toEqual(['G1'])
  })

  test('Option B never honours a LEGACY (unproven) binding for an upgraded account', async () => {
    // Shape of a binding written before Phase 1A — possibly by an attacker.
    db.seed('guestDeviceBindings/DEV-OLD', {
      uid: 'VICTIM', secretHash: sha(SECRET_B), deviceId: 'DEV-OLD',
      createdAt: Timestamp.fromMillis(Date.now() - 86400e3),
    })
    db.seed('users/VICTIM', { name: 'v' })
    providers.set('VICTIM', ['phone'])
    const r = await claim({ deviceId: 'DEV-OLD', deviceSecret: SECRET_B })
    expect(r.status).toBe('upgraded')
    expect(minted).toEqual([])
  })

  test('concurrent binds of one uid from two devices: exactly one wins', async () => {
    const [x, y] = await Promise.all([
      claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1'),
      claim({ deviceId: 'DEV-2', deviceSecret: SECRET_B, uid: 'G1' }, 'G1'),
    ])
    const statuses = [x.status, y.status].sort()
    expect(statuses).toEqual(['bound', 'bound_elsewhere'])
  })

  test('repeated bind requests from the owner are idempotent', async () => {
    const a = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    const b = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A, uid: 'G1' }, 'G1')
    expect(a.status).toBe('bound')
    expect(b.status).toBe('existing_guest')
    expect(b.uid).toBe('G1')
  })
})

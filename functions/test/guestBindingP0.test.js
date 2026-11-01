/**
 * P0-9 (AUTH-001-R) — bindings made before Phase 1A cannot keep issuing tokens
 * on trust, and the migration that indexes them is dry by default.
 *
 * Phase 1A made NEW guest bindings owner-proven and added the reverse index
 * `guestUidBindings/{uid}` → the one device that uid is the guest of. Bindings
 * written before that carry no proof — any of them could have been written by
 * an attacker naming a victim's uid — and they kept working:
 *
 *   * `touch` upgraded such a binding to `ownerVerified` for any caller signed
 *     in as the bound uid, INCLUDING a custom-token session the binding itself
 *     had just minted — the attacker's own session promoted the attacker's
 *     binding to "owner-proven";
 *   * `rekey` let the same kind of session replace the device secret;
 *   * the reverse index was consulted only on bind, so a uid bound on two
 *     devices kept handing tokens to both.
 *
 * Now a custom-token session proves nothing about ownership, token issue checks
 * the reverse index (refusing a quarantined uid, quarantining a uid found on two
 * devices, indexing a legacy binding that is the uid's only one), and
 * `scripts/migrate-guest-bindings.mjs` builds the index for every legacy binding
 * — dry run by default.
 *
 * Run:  node --test test/guestBindingP0.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const crypto = require('node:crypto')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
let minted = []
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    createCustomToken: async (uid) => { minted.push(uid); return `token-${uid}` },
    getUser: async (uid) => ({ uid, providerData: [] }),
    updateUser: async () => undefined,
    revokeRefreshTokens: async () => undefined,
  }),
})

const ID = require('../lib/identity')
const MIG = require('../lib/guestBindingMigration')

const SECRET_A = 'a'.repeat(43)
const SECRET_B = 'b'.repeat(43)
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const session = (uid, provider) => ({ auth: { uid, token: { auth_time: 2000, firebase: { sign_in_provider: provider } } } })
const claim = (data, ctx) => ID.claimGuestIdentity.run(data, ctx || {})
const legacy = (deviceId, uid, secret = SECRET_A) => db.seed(`guestDeviceBindings/${deviceId}`, {
  uid, secretHash: sha(secret), deviceId, createdAt: Timestamp.fromMillis(Date.now() - 86400e3),
})

beforeEach(() => { db._docs.clear(); minted = [] })

describe('a custom-token session proves nothing about ownership', () => {
  test('touch by a CUSTOM-token session does not promote a legacy binding', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A }, session('G1', 'custom'))
    expect(r.status).toBe('existing_guest')
    expect(db.read('guestDeviceBindings/DEV-1').ownerVerified).toBe(undefined)
  })
  test('touch by the guest\'s own ANONYMOUS session does promote it (control)', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A }, session('G1', 'anonymous'))
    expect(db.read('guestDeviceBindings/DEV-1').ownerVerified).toBe(true)
  })
  test('a CUSTOM-token session with the wrong secret cannot re-key the binding', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_B }, session('G1', 'custom'))
    expect(r.status).toBe('unrecoverable')
    expect(db.read('guestDeviceBindings/DEV-1').secretHash).toBe(sha(SECRET_A))
  })
  test('the guest\'s own ANONYMOUS session may re-key after losing the secret (control)', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_B }, session('G1', 'anonymous'))
    expect(r.status).toBe('existing_guest')
    expect(db.read('guestDeviceBindings/DEV-1').secretHash).toBe(sha(SECRET_B))
  })
})

describe('token issue checks the reverse index', () => {
  test('a quarantined uid gets no token', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    db.seed('guestUidBindings/G1', { deviceId: 'DEV-1', quarantined: true })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(r.status).toBe('unrecoverable')
    expect(minted).toEqual([])
  })
  test('a uid bound on TWO devices gets no token and is quarantined', async () => {
    legacy('DEV-1', 'G1'); legacy('DEV-2', 'G1', SECRET_B); db.seed('users/G1', { name: 'g' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(r.status).toBe('unrecoverable')
    expect(minted).toEqual([])
    expect(db.read('guestUidBindings/G1').quarantined).toBe(true)
  })
  test('a legacy binding that is its uid\'s ONLY one is indexed and gets its token', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(r.status).toBe('existing_guest')
    expect(minted).toEqual(['G1'])
    expect(db.read('guestUidBindings/G1').deviceId).toBe('DEV-1')
  })
  test('a reverse entry naming THIS device is honoured (control)', async () => {
    legacy('DEV-1', 'G1'); db.seed('users/G1', { name: 'g' })
    db.seed('guestUidBindings/G1', { deviceId: 'DEV-1' })
    const r = await claim({ deviceId: 'DEV-1', deviceSecret: SECRET_A })
    expect(minted).toEqual(['G1'])
    expect(r.status).toBe('existing_guest')
  })
})

describe('the migration plan', () => {
  const b = (deviceId, uid) => ({ deviceId, uid, createdAtMs: 1 })
  test('a uid on one device with no index entry → create', () => {
    const p = MIG.planGuestBindingMigration([b('D1', 'U1')], [])
    expect(p.create).toEqual([{ uid: 'U1', deviceId: 'D1' }])
    expect(p.stats.created).toBe(1)
  })
  test('an index entry already naming the device → unchanged', () => {
    const p = MIG.planGuestBindingMigration([b('D1', 'U1')], [{ uid: 'U1', deviceId: 'D1', quarantined: false }])
    expect(p.create.length + p.repoint.length + p.quarantine.length).toBe(0)
    expect(p.stats.unchanged).toBe(1)
  })
  test('an index entry naming another device that no longer points here → repoint', () => {
    const p = MIG.planGuestBindingMigration([b('D1', 'U1')], [{ uid: 'U1', deviceId: 'D9', quarantined: false }])
    expect(p.repoint).toEqual([{ uid: 'U1', deviceId: 'D1' }])
  })
  test('a uid bound on two devices → quarantine, with both devices recorded', () => {
    const p = MIG.planGuestBindingMigration([b('D1', 'U1'), b('D2', 'U1')], [])
    expect(p.quarantine).toEqual([{ uid: 'U1', deviceIds: ['D1', 'D2'] }])
    expect(p.create.length).toBe(0)
  })
  test('an already-quarantined uid is left for a person to resolve', () => {
    const p = MIG.planGuestBindingMigration([b('D1', 'U1')], [{ uid: 'U1', deviceId: 'D1', quarantined: true }])
    expect(p.stats.alreadyQuarantined).toBe(1)
    expect(p.create.length + p.repoint.length + p.quarantine.length).toBe(0)
  })
  test('a binding with no uid is skipped', () => {
    const p = MIG.planGuestBindingMigration([b('D1', '')], [])
    expect(p.stats.skippedEmptyUid).toBe(1)
  })
})

describe('the migration run: dry by default', () => {
  function seedWorld() {
    legacy('D1', 'U1')                                  // single, unindexed → create
    legacy('D2', 'U2'); db.seed('guestUidBindings/U2', { deviceId: 'D2' })      // already indexed
    legacy('D3', 'U3'); legacy('D4', 'U3', SECRET_B)    // two devices → quarantine
    legacy('D5', 'U5'); db.seed('guestUidBindings/U5', { deviceId: 'D-GONE' })  // stale → repoint
  }
  test('a DRY RUN reports the plan and writes nothing', async () => {
    seedWorld()
    const before = JSON.stringify([...db._docs.entries()])
    const writesBefore = db.writes
    const r = await MIG.runGuestBindingMigration(db, { apply: false })
    expect(r.applied).toBe(false)
    expect(r.writes).toBe(0)
    expect(db.writes).toBe(writesBefore)
    expect(JSON.stringify([...db._docs.entries()])).toBe(before)
    expect(r.stats).toEqual({
      bindings: 5, uids: 4, created: 1, repointed: 1, quarantined: 1,
      unchanged: 1, alreadyQuarantined: 0, skippedEmptyUid: 0,
    })
  })
  test('APPLY writes exactly the plan, and a second run is a no-op', async () => {
    seedWorld()
    const r = await MIG.runGuestBindingMigration(db, { apply: true })
    expect(r.writes).toBe(3)
    expect(db.read('guestUidBindings/U1').deviceId).toBe('D1')
    expect(db.read('guestUidBindings/U5').deviceId).toBe('D5')
    expect(db.read('guestUidBindings/U3').quarantined).toBe(true)
    const again = await MIG.runGuestBindingMigration(db, { apply: true })
    expect(again.writes).toBe(0)
    expect(again.stats.alreadyQuarantined).toBe(1)
  })
})

describe('the migration script refuses unsafe targets before touching Firebase', () => {
  const script = path.join(__dirname, '..', 'scripts', 'migrate-guest-bindings.mjs')
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 20000,
  })
  test('no --project → usage, non-zero exit', () => {
    const r = run([])
    expect(r.status !== 0).toBe(true)
  })
  test('a real project without the production confirmation → refused', () => {
    const r = run(['--project', 'real-project-123'])
    expect(r.status).toBe(2)
    expect(/ZIPPER_ALLOW_PRODUCTION_ACCESS/.test(r.stderr)).toBe(true)
  })
  test('--apply on a real project without the typed apply confirmation → refused', () => {
    const r = run(['--project', 'real-project-123', '--apply'], { ZIPPER_ALLOW_PRODUCTION_ACCESS: 'real-project-123' })
    expect(r.status).toBe(2)
    expect(/ZIPPER_CONFIRM_APPLY/.test(r.stderr)).toBe(true)
  })
  test('a demo- project without an emulator on this machine → refused', () => {
    const r = run(['--project', 'demo-zipper'])
    expect(r.status).toBe(2)
    expect(/FIRESTORE_EMULATOR_HOST/.test(r.stderr)).toBe(true)
  })
})

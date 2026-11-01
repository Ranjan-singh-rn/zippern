/**
 * B1 (Phase 1A.2) — account deletion guards.
 *
 *   N3         A stale or displaced credential cannot request, recover or finish
 *              a deletion. "Delete now" also needs a sign-in no older than ten
 *              minutes.
 *   STAFF-005  A login with protected CRM access (active staff; a partner whose
 *              role is approved, pending or suspended) cannot delete the Firebase
 *              identity it shares with the CRM, and the nightly sweep never
 *              deletes one.
 *   DEACT-001  A completed deletion leaves the queue, so completed records can
 *              no longer stop the next due account; a retry never repeats a
 *              destructive step that already happened.
 *
 * Runs the real handlers from `lib/` (exactly what deploys) against the
 * in-memory Firestore in `fakeFirestore.js`, with Firebase Auth and Cloud
 * Storage replaced by recording stubs. Nothing here can reach a real project:
 * the Admin SDK's `firestore`, `auth` and `storage` are all replaced before the
 * code under test is loaded.
 *
 * ── TWO ADAPTATIONS OF THE SHARED FAKE, LOCAL TO THIS FILE ───────────────────
 *
 * 1. `FieldValue.delete()` removes the field, as Firestore does. The shared
 *    fake stores the sentinel as an empty object instead, which would make
 *    "the due date was cleared" impossible to assert.
 * 2. `db.batch()` exists, because a purge deletes subcollections in batches.
 *
 * Both are applied to this test process only; `fakeFirestore.js` is unchanged.
 *
 * Run:  node --test test/accountLifecycle.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()

// ── Adaptation 1: real field deletes ─────────────────────────────────────────
const isDeleteSentinel = (v) =>
  v != null && typeof v === 'object' && v.constructor && v.constructor.name === 'DeleteTransform'
const DocRef = db.collection('_probe').doc('_probe').constructor
for (const method of ['set', 'update']) {
  const original = DocRef.prototype[method]
  DocRef.prototype[method] = async function patched(data, opts) {
    const drop = Object.keys(data || {}).filter((k) => isDeleteSentinel(data[k]))
    const rest = { ...data }
    for (const k of drop) delete rest[k]
    await original.call(this, rest, opts)
    const stored = this._store._docs.get(this.path)
    if (stored) for (const k of drop) delete stored[k]
  }
}

// ── Adaptation 2: batches ────────────────────────────────────────────────────
db.batch = () => {
  const ops = []
  return {
    delete: (ref) => { ops.push(() => ref.delete()) },
    set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)) },
    update: (ref, data) => { ops.push(() => ref.update(data)) },
    commit: async () => { for (const op of ops) await op() },
  }
}

// ── Firebase Auth and Cloud Storage: recording stubs ─────────────────────────
const auth = {
  users: new Set(), // uids that still have a login
  deleted: [],
  revoked: [],
  failDelete: new Set(), // uids whose deleteUser fails with a non-"not found" error
}
const notFound = (uid) => Object.assign(new Error(`no user ${uid}`), { code: 'auth/user-not-found' })
Object.defineProperty(admin, 'auth', {
  configurable: true,
  writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!auth.users.has(uid)) throw notFound(uid)
      return { uid, providerData: [] }
    },
    deleteUser: async (uid) => {
      if (auth.failDelete.has(uid)) {
        throw Object.assign(new Error('auth backend unavailable'), { code: 'auth/internal-error' })
      }
      if (!auth.users.has(uid)) throw notFound(uid)
      auth.users.delete(uid)
      auth.deleted.push(uid)
    },
    revokeRefreshTokens: async (uid) => { auth.revoked.push(uid) },
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})
const storage = { cleared: [] }
Object.defineProperty(admin, 'storage', {
  configurable: true,
  writable: true,
  value: () => ({
    bucket: () => ({ deleteFiles: async ({ prefix }) => { storage.cleared.push(prefix) } }),
  }),
})

const ACC = require('../lib/accounts')

// ── helpers ──────────────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000)
const DAY_MS = 24 * 60 * 60 * 1000

/** Call a v2 callable the way the Functions runtime does. */
const call = (fn, { uid = 'U', token = {}, data = {} } = {}) =>
  fn.run({ auth: { uid, token }, data })

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}
const detail = (e) => (e && e.details ? e.details.code : undefined)
const sweep = () => ACC.purgeDeletedAccounts.run({}, {})

/** An ordinary signed-in account with an active mobile session. */
function seedActive(uid, { session = 'S-CURRENT', validAfter = nowSec() - 120 } = {}) {
  db.seed(`users/${uid}`, {
    name: 'Asha',
    accountState: 'active',
    credentialsValidAfter: validAfter,
    activeMobileSession: { sessionId: session },
    phoneKey: '919800000000',
    email: 'asha@example.com',
  })
  auth.users.add(uid)
  return validAfter
}

/**
 * An account whose deletion was requested `requestedAgoSec` ago, as
 * `requestAccountDeletion` leaves it: recovery pending, cut-off just past the
 * request, no mobile session on record.
 */
function seedPendingDeletion(uid, { requestedAgoSec = 3600, dueAt = null } = {}) {
  const requestedAt = nowSec() - requestedAgoSec
  db.seed(`users/${uid}`, {
    name: 'Asha',
    accountState: 'recovery_pending',
    isDeleted: true,
    deletionRequestedAt: Timestamp.fromMillis(requestedAt * 1000),
    deletionDueAt: dueAt || Timestamp.fromMillis(Date.now() + 59 * DAY_MS),
    credentialsValidAfter: requestedAt + 1,
    phoneKey: '919800000000',
    email: 'asha@example.com',
  })
  auth.users.add(uid)
  return requestedAt + 1
}

const crm = (uid, doc) => db.seed(`crmUsers/${uid}`, { uid, ...doc })

beforeEach(() => {
  db._docs.clear()
  auth.users.clear()
  auth.deleted = []
  auth.revoked = []
  auth.failDelete.clear()
  storage.cleared = []
})

// ══ N3 ═══════════════════════════════════════════════════════════════════════

describe('N3 — a stale or displaced credential cannot touch the deletion state', () => {
  test('a stale session cannot request deletion', async () => {
    const cutoff = seedActive('U')
    const e = await refusal(call(ACC.requestAccountDeletion, {
      token: { auth_time: cutoff - 300 }, data: { sessionId: 'S-CURRENT' },
    }))
    expect(detail(e)).toBe('SESSION_DISPLACED')
    const doc = db.read('users/U')
    expect(doc.isDeleted).toBeUndefined()
    expect(doc.accountState).toBe('active')
    expect(auth.revoked).toEqual([])
  })

  test('a stale session cannot recover an account', async () => {
    const cutoff = seedPendingDeletion('U')
    const e = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff - 600 } }))
    expect(detail(e)).toBe('SESSION_DISPLACED')
    expect(db.read('users/U').isDeleted).toBe(true)
    expect(db.read('users/U').accountState).toBe('recovery_pending')
  })

  test('a stale session cannot purge an account, even within ten minutes of its sign-in', async () => {
    const cutoff = seedPendingDeletion('U', { requestedAgoSec: 120 })
    const e = await refusal(call(ACC.purgeMyAccountNow, { token: { auth_time: cutoff - 180 } }))
    expect(detail(e)).toBe('SESSION_DISPLACED')
    expect(auth.users.has('U')).toBe(true)
    expect(db.read('users/U').accountState).toBe('recovery_pending')
  })

  test('a mismatched session id cannot request deletion', async () => {
    const cutoff = seedActive('U')
    const e = await refusal(call(ACC.requestAccountDeletion, {
      token: { auth_time: cutoff }, data: { sessionId: 'S-OLD' },
    }))
    expect(detail(e)).toBe('SESSION_DISPLACED')
    expect(db.read('users/U').isDeleted).toBeUndefined()
  })

  test('a missing session id is not accepted as proof of the active session', async () => {
    const cutoff = seedActive('U')
    const e = await refusal(call(ACC.requestAccountDeletion, { token: { auth_time: cutoff }, data: {} }))
    expect(detail(e)).toBe('SESSION_REQUIRED')
    expect(db.read('users/U').isDeleted).toBeUndefined()
  })

  test('with no active session on record, a deletion request is refused', async () => {
    const cutoff = seedActive('U')
    const doc = db.read('users/U')
    delete doc.activeMobileSession
    db.seed('users/U', doc)
    const e = await refusal(call(ACC.requestAccountDeletion, {
      token: { auth_time: cutoff }, data: { sessionId: 'S-CURRENT' },
    }))
    expect(detail(e)).toBe('SESSION_REQUIRED')
    expect(db.read('users/U').isDeleted).toBeUndefined()
  })

  test('when a session IS on record, recovery and "Delete now" must present it', async () => {
    const cutoff = seedPendingDeletion('U', { requestedAgoSec: 120 })
    const doc = db.read('users/U')
    doc.activeMobileSession = { sessionId: 'S-NEW' }
    db.seed('users/U', doc)
    const fresh = { auth_time: cutoff + 30 }
    expect(detail(await refusal(call(ACC.recoverAccount, { token: fresh, data: {} }))))
      .toBe('SESSION_REQUIRED')
    expect(detail(await refusal(call(ACC.recoverAccount, { token: fresh, data: { sessionId: 'S-OLD' } }))))
      .toBe('SESSION_DISPLACED')
    expect(detail(await refusal(call(ACC.purgeMyAccountNow, { token: fresh, data: {} }))))
      .toBe('SESSION_REQUIRED')
    expect(detail(await refusal(call(ACC.purgeMyAccountNow, { token: fresh, data: { sessionId: 'S-OLD' } }))))
      .toBe('SESSION_DISPLACED')
    expect(auth.users.has('U')).toBe(true)
    expect(db.read('users/U').isDeleted).toBe(true)
  })

  test('a legitimate current session can request deletion', async () => {
    const cutoff = seedActive('U')
    const r = await call(ACC.requestAccountDeletion, {
      token: { auth_time: cutoff }, data: { sessionId: 'S-CURRENT' },
    })
    expect(r.requested).toBe(true)
    const doc = db.read('users/U')
    expect(doc.isDeleted).toBe(true)
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.credentialsValidAfter).toBeGreaterThan(nowSec() - 1)
    expect(auth.revoked).toEqual(['U'])
  })

  test('the same sign-in cannot purge or recover once deletion has been requested', async () => {
    const authTime = seedActive('U')
    const token = { auth_time: authTime }
    await call(ACC.requestAccountDeletion, { token, data: { sessionId: 'S-CURRENT' } })

    const purge = await refusal(call(ACC.purgeMyAccountNow, { token, data: { sessionId: 'S-CURRENT' } }))
    expect(detail(purge)).toBe('SESSION_DISPLACED')
    const recover = await refusal(call(ACC.recoverAccount, { token, data: { sessionId: 'S-CURRENT' } }))
    expect(detail(recover)).toBe('SESSION_DISPLACED')

    expect(auth.users.has('U')).toBe(true)
    expect(auth.deleted).toEqual([])
    expect(db.read('users/U').accountState).toBe('recovery_pending')
  })

  test('a fresh sign-in after the request can recover the account', async () => {
    const cutoff = seedPendingDeletion('U')
    const r = await call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 } })
    expect(r.recovered).toBe(true)
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('active')
    expect(doc.isDeleted).toBeUndefined()
    expect(doc.deletionDueAt).toBeUndefined()
  })

  test('"Delete now" succeeds with a sign-in made within the last ten minutes', async () => {
    seedPendingDeletion('U', { requestedAgoSec: 3600 })
    const r = await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 540 } })
    expect(r.purged).toBe(true)
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect(doc.phoneKey).toBe('')
    expect(doc.email).toBe('')
    expect(auth.deleted).toEqual(['U'])
    expect(storage.cleared).toEqual(['profileMedia/U/', 'hostVerification/U/'])
  })

  test('"Delete now" is refused when the sign-in is older than ten minutes', async () => {
    seedPendingDeletion('U', { requestedAgoSec: 7200 })
    const e = await refusal(call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 660 } }))
    expect(detail(e)).toBe('RECENT_SIGN_IN_REQUIRED')
    expect(auth.users.has('U')).toBe(true)
    expect(db.read('users/U').accountState).toBe('recovery_pending')
  })

  test('"Delete now" refuses missing, invalid and future auth_time values', async () => {
    seedPendingDeletion('U', { requestedAgoSec: 7200 })
    for (const token of [
      {},
      { auth_time: null },
      { auth_time: 'yesterday' },
      { auth_time: String(nowSec() - 60) },
      { auth_time: Number.NaN },
      { auth_time: 0 },
      { auth_time: -5 },
      { auth_time: nowSec() + 3600 },
    ]) {
      const e = await refusal(call(ACC.purgeMyAccountNow, { token }))
      expect(detail(e)).toBe('RECENT_SIGN_IN_REQUIRED')
    }
    expect(auth.users.has('U')).toBe(true)
    expect(db.read('users/U').accountState).toBe('recovery_pending')
  })

  test('requests and recoveries refuse missing, invalid and future auth_time values', async () => {
    seedActive('U')
    for (const token of [{}, { auth_time: 'x' }, { auth_time: nowSec() + 3600 }]) {
      const e = await refusal(call(ACC.requestAccountDeletion, { token, data: { sessionId: 'S-CURRENT' } }))
      expect(detail(e)).toBe('SESSION_DISPLACED')
    }
    expect(db.read('users/U').isDeleted).toBeUndefined()

    seedPendingDeletion('V')
    for (const token of [{}, { auth_time: 'x' }, { auth_time: nowSec() + 3600 }]) {
      const e = await refusal(call(ACC.recoverAccount, { uid: 'V', token }))
      expect(detail(e)).toBe('SESSION_DISPLACED')
    }
    expect(db.read('users/V').isDeleted).toBe(true)
  })

  test('a sign-in a few seconds ahead of the server clock (clock skew) is not treated as future', async () => {
    seedPendingDeletion('U', { requestedAgoSec: 120 })
    const r = await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() + 20 } })
    expect(r.purged).toBe(true)
  })
})

// ══ STAFF-005 ════════════════════════════════════════════════════════════════

describe('STAFF-005 — a login with protected CRM access keeps its identity', () => {
  const request = (uid) =>
    call(ACC.requestAccountDeletion, {
      uid, token: { auth_time: nowSec() - 120 }, data: { sessionId: 'S-CURRENT' },
    })

  for (const [label, doc, access] of [
    ['an Owner', { role: 'superadmin', isActive: true }, 'staff'],
    ['a department admin', { role: 'ops_admin', isActive: true }, 'staff'],
    ['an approved agency', { role: 'agency', roles: ['agency'], roleStatus: { agency: 'approved' }, isActive: true }, 'partner'],
    ['a pending coin seller', { role: 'seller', roles: ['seller'], roleStatus: { seller: 'pending' }, isActive: true }, 'partner'],
    ['a suspended agency (even with the login switched off)', { role: 'agency', roleStatus: { agency: 'suspended' }, isActive: false }, 'partner'],
    ['a legacy agency login with only a top-level status', { role: 'agency', status: 'approved' }, 'partner'],
    ['a dual-role login whose agency is revoked but seller is live', { role: 'agency', roles: ['agency', 'seller'], roleStatus: { agency: 'revoked', seller: 'approved' }, isActive: true }, 'partner'],
  ]) {
    test(`${label} cannot request deletion`, async () => {
      seedActive('C', { validAfter: nowSec() - 120 })
      crm('C', doc)
      const e = await refusal(request('C'))
      expect(detail(e)).toBe('CRM_ACCESS_HELD')
      expect(e.details.access).toBe(access)
      expect(db.read('users/C').isDeleted).toBeUndefined()
      expect(auth.revoked).toEqual([])
    })
  }

  test('an approved agency cannot finish an older deletion request with "Delete now"', async () => {
    seedPendingDeletion('C', { requestedAgoSec: 3600 })
    crm('C', { role: 'agency', roleStatus: { agency: 'approved' }, isActive: true })
    const e = await refusal(call(ACC.purgeMyAccountNow, { uid: 'C', token: { auth_time: nowSec() - 60 } }))
    expect(detail(e)).toBe('CRM_ACCESS_HELD')
    expect(auth.users.has('C')).toBe(true)
    expect(db.read('users/C').accountState).toBe('recovery_pending')
    expect(db.has('crmUsers/C')).toBe(true)
  })

  test('role names or status sent by the client are ignored; the server record decides', async () => {
    seedActive('C', { validAfter: nowSec() - 120 })
    crm('C', { role: 'superadmin', isActive: true })
    const e = await refusal(call(ACC.requestAccountDeletion, {
      uid: 'C',
      token: { auth_time: nowSec() - 120, role: 'user' },
      data: { sessionId: 'S-CURRENT', role: 'user', crmRole: '', isActive: false, roleStatus: { agency: 'revoked' } },
    }))
    expect(detail(e)).toBe('CRM_ACCESS_HELD')
  })

  for (const [label, doc] of [
    ['a deactivated staff member', { role: 'app_admin', isActive: false }],
    ['a former partner whose application was rejected', { role: 'seller', roleStatus: { seller: 'rejected' } }],
    ['a former partner whose role was revoked', { role: 'agency', roleStatus: { agency: 'revoked' }, isActive: false }],
    ['a former partner rejected for one role and revoked for the other', { role: 'agency', roles: ['agency', 'seller'], roleStatus: { agency: 'revoked', seller: 'rejected' } }],
  ]) {
    test(`${label} can still request deletion`, async () => {
      seedActive('C', { validAfter: nowSec() - 120 })
      crm('C', doc)
      const r = await request('C')
      expect(r.requested).toBe(true)
      expect(db.read('users/C').isDeleted).toBe(true)
    })
  }

  test('the nightly sweep never deletes a CRM identity: it is held, out of the queue', async () => {
    const due = Timestamp.fromMillis(Date.now() - DAY_MS)
    seedPendingDeletion('C', { dueAt: due })
    crm('C', { role: 'superadmin', isActive: true })

    await sweep()

    expect(auth.users.has('C')).toBe(true)
    expect(auth.deleted).toEqual([])
    const doc = db.read('users/C')
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.isDeleted).toBe(true)
    expect(doc.deletionDueAt).toBeUndefined()
    expect(doc.deletionHeld.reason).toBe('crm_access')
    expect(doc.deletionHeld.access).toBe('staff')
    expect(doc.deletionHeld.dueAt.toMillis()).toBe(due.toMillis())
    expect(db.read('crmUsers/C').role).toBe('superadmin')

    // A second night does nothing to it.
    const before = db.writes
    await sweep()
    expect(db.writes).toBe(before)
    expect(auth.users.has('C')).toBe(true)
  })

  test('once the CRM access is gone, the person can finish the held deletion', async () => {
    seedPendingDeletion('C', { requestedAgoSec: 3600, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    crm('C', { role: 'agency', roleStatus: { agency: 'approved' }, isActive: true })
    await sweep()
    expect(db.read('users/C').deletionHeld.access).toBe('partner')

    crm('C', { role: 'agency', roleStatus: { agency: 'revoked' }, isActive: false })
    const r = await call(ACC.purgeMyAccountNow, { uid: 'C', token: { auth_time: nowSec() - 60 } })
    expect(r.purged).toBe(true)
    const doc = db.read('users/C')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect(doc.deletionHeld).toBeUndefined()
    expect(auth.deleted).toEqual(['C'])
  })
})

// ══ DEACT-001 ════════════════════════════════════════════════════════════════

describe('DEACT-001 — completed deletions leave the queue', () => {
  /** A record a previous purge completed, but that still carries its due date. */
  function seedCompleted(uid, dueMs) {
    db.seed(`users/${uid}`, {
      accountState: 'permanently_deactivated',
      isDeleted: true,
      deletionDueAt: Timestamp.fromMillis(dueMs),
      purgedAt: Timestamp.fromMillis(dueMs),
      phoneKey: '',
      email: '',
    })
  }

  test('a purge clears the due date', async () => {
    seedPendingDeletion('U', { requestedAgoSec: 3600 })
    await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 60 } })
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect(doc.deletionDueAt).toBeUndefined()
  })

  test('60 completed records ahead of one due account cannot stop it', async () => {
    const oldest = Date.now() - 40 * DAY_MS
    for (let i = 0; i < 60; i++) seedCompleted(`DONE${String(i).padStart(2, '0')}`, oldest + i * 60_000)
    seedPendingDeletion('DUE', { requestedAgoSec: 61 * 24 * 3600, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })

    await sweep()

    const due = db.read('users/DUE')
    expect(due.accountState).toBe('permanently_deactivated')
    expect(due.deletionDueAt).toBeUndefined()
    expect(auth.deleted).toEqual(['DUE'])
    // The completed records were taken out of the queue without repeating a purge.
    expect(storage.cleared).toEqual(['profileMedia/DUE/', 'hostVerification/DUE/'])
    for (let i = 0; i < 60; i++) {
      expect(db.read(`users/DONE${String(i).padStart(2, '0')}`).deletionDueAt).toBeUndefined()
    }
  })

  test('running the sweep again repeats nothing', async () => {
    const oldest = Date.now() - 40 * DAY_MS
    for (let i = 0; i < 60; i++) seedCompleted(`DONE${String(i).padStart(2, '0')}`, oldest + i * 60_000)
    seedPendingDeletion('DUE', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    await sweep()

    const writes = db.writes
    const deletes = db.deletes
    await sweep()
    expect(db.writes).toBe(writes)
    expect(db.deletes).toBe(deletes)
    expect(auth.deleted).toEqual(['DUE'])
    expect(storage.cleared).toEqual(['profileMedia/DUE/', 'hostVerification/DUE/'])
  })

  test('a purge whose login deletion failed stays queued, and the retry repeats nothing else', async () => {
    seedPendingDeletion('U', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    auth.failDelete.add('U')

    await sweep()
    let doc = db.read('users/U')
    expect(auth.users.has('U')).toBe(true)
    expect(doc.accountState).toBe('permanently_deactivated') // identity already released
    expect(doc.deletionDueAt).toBeTruthy() // still queued for the retry
    expect(storage.cleared).toEqual(['profileMedia/U/', 'hostVerification/U/'])

    auth.failDelete.clear()
    await sweep()
    doc = db.read('users/U')
    expect(auth.deleted).toEqual(['U'])
    expect(doc.deletionDueAt).toBeUndefined()
    expect(storage.cleared).toEqual(['profileMedia/U/', 'hostVerification/U/']) // not cleared a second time
  })

  test('the 60-day recovery period is unchanged', () => {
    expect(ACC.GRACE_DAYS).toBe(60)
  })
})

// ══ The ordinary lifecycle, end to end ═══════════════════════════════════════

describe('the legitimate lifecycle still works', () => {
  test('request → fresh sign-in → recover → new session → request → fresh sign-in → Delete now', async () => {
    let authTime = seedActive('U', { session: 'S1' })
    let r = await call(ACC.requestAccountDeletion, { token: { auth_time: authTime }, data: { sessionId: 'S1' } })
    expect(r.requested).toBe(true)

    // The app signs out; the person signs in again. That sign-in is newer than
    // the cut-off the request set (cut-off = request time + 1 s).
    authTime = db.read('users/U').credentialsValidAfter
    r = await call(ACC.recoverAccount, { token: { auth_time: authTime } })
    expect(r.recovered).toBe(true)
    expect(db.read('users/U').accountState).toBe('active')

    // Back in the app: startMobileSession records a new session and cut-off.
    const doc = db.read('users/U')
    doc.activeMobileSession = { sessionId: 'S2' }
    doc.credentialsValidAfter = authTime
    db.seed('users/U', doc)
    r = await call(ACC.requestAccountDeletion, { token: { auth_time: authTime }, data: { sessionId: 'S2' } })
    expect(r.requested).toBe(true)

    authTime = db.read('users/U').credentialsValidAfter
    r = await call(ACC.purgeMyAccountNow, { token: { auth_time: authTime } })
    expect(r.purged).toBe(true)
    expect(db.read('users/U').accountState).toBe('permanently_deactivated')
    expect(auth.deleted).toEqual(['U'])
  })

  test('a device that still holds an old local session id can recover after signing in again', async () => {
    const cutoff = seedPendingDeletion('U')
    const r = await call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 }, data: { sessionId: 'S-LEFT-OVER' } })
    expect(r.recovered).toBe(true)
  })
})

// ══ C8 (B27) — no recovery after the due date ════════════════════════════════

describe('C8 (B27) — recovery is refused once deletionDueAt has passed', () => {
  const ID = require('../lib/identity')
  const resolve = (uid) => ID.resolveIdentity.run({}, {
    auth: { uid, token: { phone_number: '+919800000000', firebase: { sign_in_provider: 'phone' } } },
  })

  /** Run [fn] with the clock pinned at [ms], so "due exactly now" is exact. */
  async function at(ms, fn) {
    const real = Date.now
    Date.now = () => ms
    try { return await fn() } finally { Date.now = real }
  }

  test('past the due date, still recovery_pending (sweep not yet run) → RECOVERY_EXPIRED; nothing changes', async () => {
    const cutoff = seedPendingDeletion('U', { requestedAgoSec: 61 * 24 * 3600, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    const e = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 } }))
    expect(e && e.code).toBe('failed-precondition')
    expect(detail(e)).toBe('RECOVERY_EXPIRED')
    const doc = db.read('users/U')
    expect(doc.isDeleted).toBe(true)
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.deletionDueAt).toBeTruthy()
    expect(doc.recoveredAt).toBeUndefined()
  })

  test('boundary: due EXACTLY now is expired; one millisecond before it is not', async () => {
    const NOW = Date.now()
    await at(NOW, async () => {
      const cutoff = seedPendingDeletion('U', { dueAt: Timestamp.fromMillis(NOW) })
      const e = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 } }))
      expect(detail(e)).toBe('RECOVERY_EXPIRED')
      expect(db.read('users/U').isDeleted).toBe(true)
      expect((await resolve('U')).decision).toBe('deleted_permanent')
    })
    await at(NOW, async () => {
      const cutoff = seedPendingDeletion('V', { dueAt: Timestamp.fromMillis(NOW + 1) })
      expect((await resolve('V')).decision).toBe('deleted_recoverable')
      const r = await call(ACC.recoverAccount, { uid: 'V', token: { auth_time: cutoff + 60 } })
      expect(r.recovered).toBe(true)
    })
  })

  test('the permanently-deactivated refusal carries the same code', async () => {
    const cutoff = seedPendingDeletion('U')
    const doc = db.read('users/U')
    doc.accountState = 'permanently_deactivated'
    db.seed('users/U', doc)
    const e = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 } }))
    expect(detail(e)).toBe('RECOVERY_EXPIRED')
  })

  test('resolveIdentity reports deleted_permanent past the due date, recoverable inside it', async () => {
    seedPendingDeletion('U', { dueAt: Timestamp.fromMillis(Date.now() - 1000) })
    expect((await resolve('U')).decision).toBe('deleted_permanent')
    seedPendingDeletion('V', { dueAt: Timestamp.fromMillis(Date.now() + 59 * DAY_MS) })
    expect((await resolve('V')).decision).toBe('deleted_recoverable')
  })

  test('a deletion HELD by the sweep (STAFF-005) has no due date and stays recoverable', async () => {
    const cutoff = seedPendingDeletion('C', { requestedAgoSec: 3600, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    crm('C', { role: 'superadmin', isActive: true })
    await sweep()
    expect(db.read('users/C').deletionDueAt).toBeUndefined()
    const r = await call(ACC.recoverAccount, { uid: 'C', token: { auth_time: cutoff + 60 } })
    expect(r.recovered).toBe(true)
  })

  test('the recoveryExpired decision itself', () => {
    expect(ACC.recoveryExpired(null, 1000)).toBe(false)
    expect(ACC.recoveryExpired(undefined, 1000)).toBe(false)
    expect(ACC.recoveryExpired({ toMillis: () => 1000 }, 1000)).toBe(true)
    expect(ACC.recoveryExpired({ toMillis: () => 1001 }, 1000)).toBe(false)
    expect(ACC.recoveryExpired('2026-01-01', 1000)).toBe(false)
  })
})

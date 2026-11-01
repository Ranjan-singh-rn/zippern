/**
 * Spec §7 — account deletion, verified end to end (functions hygiene batch,
 * audit 02-functions.md F-10 / F-21, 2026-11-01).
 *
 *   * a self-deactivation enters `recovery_pending` with the 60-day window;
 *   * a REPEATED request does not move the deadline (and writes nothing);
 *   * recovery before the due date restores; at/after it `RECOVERY_EXPIRED`,
 *     then the scheduled purge finishes the deletion;
 *   * staff / partner identities are refused or held, never purged around —
 *     governance and audit records survive;
 *   * a purge is idempotent and respects financial retention: the ledger
 *     subcollections and the top-level money rows stay, the person's own
 *     content goes, the user document is anonymised;
 *   * F-10: `hostVerification/{uid}/` (biometric captures) is deleted from
 *     Storage beside `profileMedia/{uid}/`, and a Storage failure is a
 *     recorded debt the sweep retries — not an orphan;
 *   * F-21: the open-withdrawal check fails CLOSED — a read error blocks the
 *     deletion (callables answer `unavailable`, the sweep retries the account).
 *
 * The shipped handlers from `lib/` over the fake Firestore; Auth and Storage
 * are recording stubs with failure injection.
 *
 * Run:  node --test test/accountDeletionSpec7.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()

// ── Failure injection on the fake's query reads (F-21) ───────────────────────
const QueryProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('_probe')))
const originalGet = QueryProto.get
const failingReads = new Set()
QueryProto.get = async function patchedGet() {
  if (typeof this._collection === 'string' && failingReads.has(this._collection)) {
    throw Object.assign(new Error('14 UNAVAILABLE: The datastore operation timed out'), { code: 14 })
  }
  return originalGet.call(this)
}

// ── Firebase Auth and Cloud Storage: recording stubs ─────────────────────────
const auth = { users: new Set(), deleted: [], revoked: [] }
const notFound = (uid) => Object.assign(new Error(`no user ${uid}`), { code: 'auth/user-not-found' })
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!auth.users.has(uid)) throw notFound(uid)
      return { uid, providerData: [] }
    },
    deleteUser: async (uid) => {
      if (!auth.users.has(uid)) throw notFound(uid)
      auth.users.delete(uid)
      auth.deleted.push(uid)
    },
    revokeRefreshTokens: async (uid) => { auth.revoked.push(uid) },
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})
const storage = { cleared: [], failPrefixes: new Set() }
Object.defineProperty(admin, 'storage', {
  configurable: true, writable: true,
  value: () => ({
    bucket: () => ({
      deleteFiles: async ({ prefix }) => {
        if (storage.failPrefixes.has(prefix)) throw new Error('storage unavailable')
        storage.cleared.push(prefix)
      },
    }),
  }),
})

const ACC = require('../lib/accounts')
const ROSTER = require('../lib/roster')

// ── helpers ──────────────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000)
const DAY_MS = 24 * 60 * 60 * 1000
const call = (fn, { uid = 'U', token = {}, data = {} } = {}) => fn.run({ auth: { uid, token }, data })
async function refusal(p) { try { await p } catch (e) { return e } return null }
const detail = (e) => (e && e.details ? e.details.code : undefined)
const sweep = () => ACC.purgeDeletedAccounts.run({}, {})

function seedActive(uid, { session = 'S-CURRENT', validAfter = nowSec() - 120, extra = {} } = {}) {
  db.seed(`users/${uid}`, {
    name: 'Asha', photoUrl: 'https://x/p.jpg', bio: 'hi', accountState: 'active',
    credentialsValidAfter: validAfter, activeMobileSession: { sessionId: session },
    phoneKey: '919800000000', phoneNumber: '+919800000000', email: 'asha@example.com',
    diamonds: 120, beans: 30, beansAvailable: 0, isHost: false, ...extra,
  })
  auth.users.add(uid)
  return validAfter
}

function seedPending(uid, { requestedAgoSec = 3600, dueAt = null, extra = {} } = {}) {
  const requestedAt = nowSec() - requestedAgoSec
  db.seed(`users/${uid}`, {
    name: 'Asha', photoUrl: 'https://x/p.jpg', accountState: 'recovery_pending', isDeleted: true,
    deletionRequestedAt: Timestamp.fromMillis(requestedAt * 1000),
    deletionDueAt: dueAt || Timestamp.fromMillis(Date.now() + 59 * DAY_MS),
    credentialsValidAfter: requestedAt + 1,
    phoneKey: '919800000000', email: 'asha@example.com', agencyId: 'AG1',
    diamonds: 120, beans: 30, beansAvailable: 0, ...extra,
  })
  auth.users.add(uid)
  return requestedAt + 1
}

/** The records a purge must keep and the ones it must remove, for one uid. */
function seedHistory(uid) {
  for (const sub of ACC.RETAINED_SUBCOLLECTIONS) db.seed(`users/${uid}/${sub}/R1`, { kept: true, amount: 10 })
  for (const sub of ['fcmTokens', 'followers', 'following', 'ownedItems']) db.seed(`users/${uid}/${sub}/P1`, { gone: true })
  db.seed(`publicProfiles/${uid}`, { name: 'Asha' })
  db.seed(`hostVerification/${uid}`, { status: 'approved' })
  db.seed(`giftTransactions/G1`, { senderUid: uid, receiverUid: 'H', diamondCost: 100, beansCredited: 50 })
  db.seed(`platformRevenue/PR1`, { type: 'gift', senderUid: uid, grossDiamonds: 100 })
  db.seed(`withdrawalRequests/W-paid`, { hostUid: uid, status: 'paid', beans: 500 })
  db.seed(`agencies/AG1/agencyHosts/${uid}`, { uid, name: 'Asha', status: 'active' })
}

beforeEach(() => {
  db._docs.clear()
  auth.users.clear(); auth.deleted = []; auth.revoked = []
  storage.cleared = []; storage.failPrefixes.clear()
  failingReads.clear()
})

// ══ request → recovery_pending, 60 days, and the deadline never moves ════════

describe('§7 request: recovery_pending with the 60-day window; repeated requests do not reset it', () => {
  test('a request enters recovery_pending with deletionDueAt = now + 60 days (server clock)', async () => {
    const t = seedActive('U')
    const before = Date.now()
    const r = await call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } })
    expect(r.requested).toBe(true)
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.isDeleted).toBe(true)
    expect(ACC.GRACE_DAYS).toBe(60)
    const due = doc.deletionDueAt.toMillis()
    expect(due).toBeGreaterThanOrEqual(before + 60 * DAY_MS)
    expect(due).toBeLessThanOrEqual(Date.now() + 60 * DAY_MS)
    expect(r.dueAtMs).toBe(due)
    // Hidden, signed out, refresh tokens revoked.
    expect(doc.isListed).toBe(false)
    expect(doc.activeMobileSession).toBeUndefined()
    expect(auth.revoked).toEqual(['U'])
  })

  test('a repeated request from a fresh session answers the ORIGINAL due date and writes nothing', async () => {
    const t = seedActive('U')
    const first = await call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } })
    const after1 = db.read('users/U')

    // The person signs in again (after the cut-off) and a new session is
    // started — startMobileSession admits a recovery_pending account — then
    // taps "delete" a second time.
    const fresh = after1.credentialsValidAfter + 30
    db.seed('users/U', { ...after1, activeMobileSession: { sessionId: 'S-NEW' } })
    const writes = db.writes
    const second = await call(ACC.requestAccountDeletion, { token: { auth_time: fresh }, data: { sessionId: 'S-NEW' } })

    expect(second.requested).toBe(true)
    expect(second.alreadyDeleted).toBe(false)
    expect(second.dueAtMs).toBe(first.dueAtMs)
    const after2 = db.read('users/U')
    expect(after2.deletionDueAt.toMillis()).toBe(after1.deletionDueAt.toMillis())
    expect(after2.deletionRequestedAt.toMillis()).toBe(after1.deletionRequestedAt.toMillis())
    expect(after2.credentialsValidAfter).toBe(after1.credentialsValidAfter)
    expect(db.writes).toBe(writes)                 // nothing written by the repeat
    expect(auth.revoked).toEqual(['U'])            // not revoked a second time
  })

  test('a repeated request from the displaced device is refused outright and moves nothing', async () => {
    const t = seedActive('U')
    const first = await call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } })
    const e = await refusal(call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } }))
    expect(detail(e)).toBe('SESSION_DISPLACED')
    expect(db.read('users/U').deletionDueAt.toMillis()).toBe(first.dueAtMs)
  })

  test('a request on an account already past the due date (sweep not yet run) keeps that older due date', async () => {
    const cutoff = seedPending('U', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    db.seed('users/U', { ...db.read('users/U'), activeMobileSession: { sessionId: 'S-NEW' } })
    const r = await call(ACC.requestAccountDeletion, { token: { auth_time: cutoff + 60 }, data: { sessionId: 'S-NEW' } })
    expect(r.requested).toBe(true)
    expect(r.dueAtMs).toBeLessThan(Date.now())
  })
})

// ══ recover before the due date; RECOVERY_EXPIRED after; then the purge ══════

describe('§7 recovery window, expiry and the scheduled purge', () => {
  test('recovery before the due date restores the account exactly', async () => {
    const t = seedActive('U')
    await call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } })
    const fresh = db.read('users/U').credentialsValidAfter
    const r = await call(ACC.recoverAccount, { token: { auth_time: fresh } })
    expect(r.recovered).toBe(true)
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('active')
    expect(doc.isDeleted).toBeUndefined()
    expect(doc.deletionDueAt).toBeUndefined()
    expect(doc.deletionRequestedAt).toBeUndefined()
    expect(doc.name).toBe('Asha')
    expect(doc.phoneKey).toBe('919800000000')
    expect(doc.diamonds).toBe(120)
    expect(auth.users.has('U')).toBe(true)
  })

  test('expired → RECOVERY_EXPIRED → the sweep purges → still RECOVERY_EXPIRED, history kept', async () => {
    const cutoff = seedPending('U', { requestedAgoSec: 61 * 24 * 3600, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    seedHistory('U')

    // 1. Past the deadline, before the sweep: refused, nothing changes.
    const e1 = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff + 60 } }))
    expect(detail(e1)).toBe('RECOVERY_EXPIRED')
    expect(db.read('users/U').accountState).toBe('recovery_pending')
    expect(auth.users.has('U')).toBe(true)

    // 2. The scheduled purge finishes the deletion.
    await sweep()
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect(doc.deletionDueAt).toBeUndefined()
    expect(auth.deleted).toEqual(['U'])

    // 3. Still refused afterwards, with the same code; the record is not revived.
    const e2 = await refusal(call(ACC.recoverAccount, { token: { auth_time: cutoff + 120 } }))
    expect(detail(e2)).toBe('RECOVERY_EXPIRED')
    expect(db.read('users/U').accountState).toBe('permanently_deactivated')
    for (const sub of ACC.RETAINED_SUBCOLLECTIONS) expect(db.has(`users/U/${sub}/R1`)).toBe(true)
  })
})

// ══ staff / partner identities ═══════════════════════════════════════════════

describe('§7 staff and partner identities cannot self-delete around governance', () => {
  test('an Owner is refused CRM_ACCESS_HELD and the sweep holds the record; crmUsers and audit rows survive', async () => {
    const t = seedActive('O')
    db.seed('crmUsers/O', { uid: 'O', role: 'superadmin', isActive: true })
    db.seed('users/O/warnings/W1', { reason: 'test' })
    const e = await refusal(call(ACC.requestAccountDeletion, { uid: 'O', token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } }))
    expect(detail(e)).toBe('CRM_ACCESS_HELD')
    expect(e.details.access).toBe('staff')
    expect(db.read('users/O').isDeleted).toBeUndefined()

    // A request that predates the CRM role (seeded directly) is HELD by the sweep.
    seedPending('O', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    await sweep()
    const doc = db.read('users/O')
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.deletionHeld.reason).toBe('crm_access')
    expect(db.read('crmUsers/O').role).toBe('superadmin')
    expect(db.has('users/O/warnings/W1')).toBe(true)
    expect(auth.deleted).toEqual([])
  })

  test('a Host with unsettled responsibilities is refused PARTNER_RESPONSIBILITIES on both callables and held by the sweep', async () => {
    const t = seedActive('H', { extra: { isHost: true, beansAvailable: 250 } })
    const e = await refusal(call(ACC.requestAccountDeletion, { uid: 'H', token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } }))
    expect(detail(e)).toBe('PARTNER_RESPONSIBILITIES')
    expect(e.details.blockers).toEqual(['host_role', 'unpaid_earnings'])

    seedPending('H', { requestedAgoSec: 120, dueAt: Timestamp.fromMillis(Date.now() - DAY_MS), extra: { isHost: true } })
    const e2 = await refusal(call(ACC.purgeMyAccountNow, { uid: 'H', token: { auth_time: nowSec() - 60 } }))
    expect(detail(e2)).toBe('PARTNER_RESPONSIBILITIES')
    await sweep()
    expect(db.read('users/H').deletionHeld.reason).toBe('partner_responsibilities')
    expect(db.read('users/H').accountState).toBe('recovery_pending')
    expect(auth.deleted).toEqual([])
  })
})

// ══ the purge: idempotent, retention-respecting, and F-10 ════════════════════

describe('§7 purge: what is deleted, anonymised and retained', () => {
  test('ledger subcollections and top-level money rows stay; own content goes; the document is anonymised', async () => {
    seedPending('U', { requestedAgoSec: 3600 })
    seedHistory('U')
    const r = await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 60 } })
    expect(r.purged).toBe(true)

    // RETAINED
    for (const sub of ACC.RETAINED_SUBCOLLECTIONS) expect(db.has(`users/U/${sub}/R1`)).toBe(true)
    expect(db.has('giftTransactions/G1')).toBe(true)
    expect(db.has('platformRevenue/PR1')).toBe(true)
    expect(db.has('withdrawalRequests/W-paid')).toBe(true)
    expect(db.has('agencies/AG1/agencyHosts/U')).toBe(true)        // marked inactive, not deleted
    expect(ROSTER.rosterRowIsCurrent(db.read('agencies/AG1/agencyHosts/U'))).toBe(false)

    // DELETED
    for (const sub of ['fcmTokens', 'followers', 'following', 'ownedItems']) expect(db.has(`users/U/${sub}/P1`)).toBe(false)
    expect(db.has('publicProfiles/U')).toBe(false)
    expect(db.has('hostVerification/U')).toBe(false)
    expect(auth.deleted).toEqual(['U'])
    expect(storage.cleared).toEqual(['profileMedia/U/', 'hostVerification/U/'])

    // ANONYMISED — the skeleton stays
    const doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect([doc.name, doc.photoUrl, doc.phoneKey, doc.phoneNumber ?? '', doc.email]).toEqual(['', '', '', '', ''])
    expect(doc.agencyId).toBe('AG1')
    expect(doc.diamonds).toBe(120)
    expect(doc.beans).toBe(30)
    expect(doc.deletionDueAt).toBeUndefined()
    expect(doc.storagePurgePending).toBeUndefined()
  })

  test('"Delete now" twice: the second call finishes without repeating any destructive step', async () => {
    seedPending('U', { requestedAgoSec: 3600 })
    seedHistory('U')
    await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 60 } })
    const deletes = db.deletes
    const cleared = storage.cleared.length
    const r = await call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 30 } })
    expect(r.purged).toBe(true)
    expect(db.deletes).toBe(deletes)
    expect(storage.cleared.length).toBe(cleared)
    expect(auth.deleted).toEqual(['U'])
    for (const sub of ACC.RETAINED_SUBCOLLECTIONS) expect(db.has(`users/U/${sub}/R1`)).toBe(true)
  })

  test('F-10: a Storage failure on the biometric prefix is a recorded debt — the sweep retries ONLY that prefix, then completes', async () => {
    seedPending('U', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    storage.failPrefixes.add('hostVerification/U/')

    await sweep()
    let doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')  // identity released
    expect(auth.deleted).toEqual(['U'])                        // login gone
    expect(doc.storagePurgePending).toEqual(['hostVerification/U/'])
    expect(doc.deletionDueAt).toBeTruthy()                     // still queued
    expect(storage.cleared).toEqual(['profileMedia/U/'])

    // Storage still down: stays queued, nothing else repeats.
    await sweep()
    expect(db.read('users/U').deletionDueAt).toBeTruthy()
    expect(storage.cleared).toEqual(['profileMedia/U/'])

    // Storage back: only the owed prefix is retried, then the record leaves the queue.
    storage.failPrefixes.clear()
    await sweep()
    doc = db.read('users/U')
    expect(storage.cleared).toEqual(['profileMedia/U/', 'hostVerification/U/'])
    expect(doc.storagePurgePending).toBeUndefined()
    expect(doc.deletionDueAt).toBeUndefined()
    expect(auth.deleted).toEqual(['U'])
  })

  test('the purged Storage prefixes are exactly the two documented ones', () => {
    expect(ACC.purgedStoragePrefixes('abc')).toEqual(['profileMedia/abc/', 'hostVerification/abc/'])
  })
})

// ══ F-21: the open-withdrawal check fails closed ═════════════════════════════

describe('F-21: a withdrawalRequests read error blocks the deletion instead of waving it through', () => {
  test('requestAccountDeletion answers unavailable and writes nothing', async () => {
    const t = seedActive('U')
    failingReads.add('withdrawalRequests')
    const writes = db.writes
    const e = await refusal(call(ACC.requestAccountDeletion, { token: { auth_time: t }, data: { sessionId: 'S-CURRENT' } }))
    expect(e && e.code).toBe('unavailable')
    expect(detail(e)).toBe('DELETION_CHECK_UNAVAILABLE')
    expect(db.writes).toBe(writes)
    expect(db.read('users/U').isDeleted).toBeUndefined()
    expect(auth.revoked).toEqual([])
  })

  test('purgeMyAccountNow answers unavailable; the login and the record are untouched', async () => {
    seedPending('U', { requestedAgoSec: 3600 })
    failingReads.add('withdrawalRequests')
    const e = await refusal(call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 60 } }))
    expect(detail(e)).toBe('DELETION_CHECK_UNAVAILABLE')
    expect(auth.users.has('U')).toBe(true)
    expect(db.read('users/U').accountState).toBe('recovery_pending')
    expect(storage.cleared).toEqual([])
  })

  test('the sweep keeps the account queued and purges it once the read works again', async () => {
    seedPending('U', { dueAt: Timestamp.fromMillis(Date.now() - DAY_MS) })
    failingReads.add('withdrawalRequests')
    await sweep()
    let doc = db.read('users/U')
    expect(doc.accountState).toBe('recovery_pending')
    expect(doc.deletionDueAt).toBeTruthy()
    expect(doc.deletionHeld).toBeUndefined()
    expect(auth.users.has('U')).toBe(true)

    failingReads.clear()
    await sweep()
    doc = db.read('users/U')
    expect(doc.accountState).toBe('permanently_deactivated')
    expect(auth.deleted).toEqual(['U'])
  })

  test('an open withdrawal that IS readable still blocks, as before', async () => {
    seedPending('U', { requestedAgoSec: 3600 })
    db.seed('withdrawalRequests/W1', { hostUid: 'U', status: 'processing', beans: 100 })
    const e = await refusal(call(ACC.purgeMyAccountNow, { token: { auth_time: nowSec() - 60 } }))
    expect(detail(e)).toBe('PARTNER_RESPONSIBILITIES')
    expect(e.details.blockers).toEqual(['open_withdrawal'])
  })
})

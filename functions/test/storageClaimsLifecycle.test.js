/**
 * The claim lifecycle, driven through the real trigger handler.
 *
 * `storageClaims.test.js` beside this one tests `decideClaim` — the decision
 * in isolation. This one drives `syncClaim`, which is the entire body of the
 * `syncStorageRoleClaim` trigger: `index.ts` supplies nothing but a two-method
 * adapter over `admin.auth()`. So what is exercised here is the code that
 * actually runs in production, including the merge that preserves unrelated
 * claims and the skip that avoids a pointless write.
 *
 * ── THE PROPERTY THAT MATTERS MOST ───────────────────────────────────────────
 *
 * Partner `crmUsers` documents are written BY THE CLIENT, in the browser, with
 * the new partner's own token. Section 1 is therefore not a mapping test. It
 * is an attack: every internal role string, in both vocabularies, plus the
 * legacy spellings, plus prototype keys, plus type confusion — written into a
 * document as a browser could write it, and asserted to produce no internal
 * claim and no privileged access.
 *
 * ── WHAT IS REAL AND WHAT IS NOT ─────────────────────────────────────────────
 *
 * REAL: `syncClaim`, imported from the compiled `lib/`.
 * FAKE: `admin.auth()`, replaced by an in-memory store whose contents are read
 *       back and asserted — so a write that does not happen fails, rather than
 *       passing because nothing checked.
 *
 * Run:  node --test test/storageClaimsLifecycle.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const { syncClaim } = require('../lib/storageClaims')

// ── An auth store that behaves like the Admin SDK, including its sharp edge ──
//
// `setCustomUserClaims` REPLACES the whole claims object. The fake does the
// same, so a handler that forgot to merge would lose unrelated claims here
// exactly as it would in production.
function makeAuth(initial = {}) {
  const users = new Map(Object.entries(initial))
  const writes = []
  return {
    users,
    writes,
    async getClaims(uid) {
      if (!users.has(uid)) throw new Error(`no user ${uid}`)
      return { ...users.get(uid) }
    },
    async setClaims(uid, claims) {
      writes.push({ uid, claims: { ...claims } })
      users.set(uid, { ...claims })
    },
  }
}

const agency = (over = {}) => ({ role: 'agency', agencyId: 'AG7', isActive: true, ...over })
const seller = (over = {}) => ({ role: 'seller', agencyId: '', isActive: true, ...over })

describe('1. a client cannot manufacture a privileged claim', () => {
  // Both vocabularies, the legacy spellings, and the machine credential.
  const PRIVILEGED = [
    'owner', 'observer', 'superadmin',
    'app_admin', 'app_member', 'ops_admin', 'ops_member',
    'finance_admin', 'finance_member', 'tech_admin', 'tech_member',
    'support_admin', 'support_member', 'marketing_admin', 'marketing_member',
    'admin', 'ops', 'tech', 'finance', 'support', 'system',
  ]

  for (const role of PRIVILEGED) {
    test(`writing crmUsers.role = '${role}' grants nothing`, async () => {
      const auth = makeAuth({ u: {} })
      const r = await syncClaim('u', { role, agencyId: 'AG7', isActive: true }, auth)
      expect(r.action).toBe('none')
      expect(auth.users.get('u')).toEqual({})
      expect(auth.writes.length).toBe(0)
    })
  }

  test('nor can it escalate from an existing agency claim', async () => {
    // The realistic shape of the attack: a partner already holds 'agency' and
    // edits its own document to claim something better.
    for (const role of PRIVILEGED) {
      const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
      await syncClaim('u', { role, agencyId: 'AG7', isActive: true }, auth)
      const got = auth.users.get('u')
      // Either untouched or cleared — never upgraded.
      expect(got.role === 'agency' || got.role === undefined).toBe(true)
    }
  })

  test('prototype keys do not resolve to a role', async () => {
    for (const role of ['constructor', '__proto__', 'toString', 'valueOf']) {
      const auth = makeAuth({ u: {} })
      await syncClaim('u', { role, isActive: true }, auth)
      expect(auth.users.get('u')).toEqual({})
    }
  })

  test('type confusion does not', async () => {
    for (const role of [null, 0, 1, true, {}, [], ['agency'], { toString: () => 'agency' }]) {
      const auth = makeAuth({ u: {} })
      await syncClaim('u', { role, isActive: true }, auth)
      expect(auth.users.get('u')).toEqual({})
    }
  })

  test('and an aid alone grants nothing without a partner role', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', { role: 'owner', agencyId: 'AG7', isActive: true }, auth)
    expect(auth.users.get('u')).toEqual({})
  })
})

describe('2. agency lifecycle', () => {
  test('creation grants the claim, scoped to its own id', async () => {
    const auth = makeAuth({ u: {} })
    const r = await syncClaim('u', agency(), auth)
    expect(r.action).toBe('set')
    expect(auth.users.get('u')).toEqual({ role: 'agency', aid: 'AG7' })
  })

  test('the aid is the document’s, never another agency’s', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', agency({ agencyId: 'SUB3' }), auth)
    expect(auth.users.get('u').aid).toBe('SUB3')
  })

  test('transfer replaces the aid', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
    const r = await syncClaim('u', agency({ agencyId: 'AG9' }), auth)
    expect(r.action).toBe('set')
    expect(auth.users.get('u')).toEqual({ role: 'agency', aid: 'AG9' })
  })

  test('suspension clears it', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
    const r = await syncClaim('u', agency({ isActive: false }), auth)
    expect(r.action).toBe('cleared')
    expect(auth.users.get('u').role).toBe(undefined)
  })

  test('reactivation restores it, with the right aid', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', agency({ isActive: true }), auth)
    expect(auth.users.get('u')).toEqual({ role: 'agency', aid: 'AG7' })
  })

  test('deletion clears it', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
    const r = await syncClaim('u', null, auth)
    expect(r.action).toBe('cleared')
    expect(auth.users.get('u')).toEqual({})
  })

  test('a pending agency still gets one — uploading KYC is what approval waits for', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', agency({ status: 'pending' }), auth)
    expect(auth.users.get('u').role).toBe('agency')
  })
})

describe('3. seller lifecycle', () => {
  test('creation', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', seller(), auth)
    expect(auth.users.get('u')).toEqual({ role: 'seller', aid: '' })
  })
  test('deactivation', async () => {
    const auth = makeAuth({ u: { role: 'seller', aid: '' } })
    await syncClaim('u', seller({ isActive: false }), auth)
    expect(auth.users.get('u').role).toBe(undefined)
  })
  test('reactivation', async () => {
    const auth = makeAuth({ u: {} })
    await syncClaim('u', seller(), auth)
    expect(auth.users.get('u').role).toBe('seller')
  })
  test('agency becomes seller', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
    await syncClaim('u', seller(), auth)
    expect(auth.users.get('u')).toEqual({ role: 'seller', aid: '' })
  })
})

describe('4. staff uids belong to the API, and this trigger keeps off them', () => {
  for (const role of ['owner', 'observer', 'finance_admin', 'ops_member']) {
    test(`a crmUsers edit does not disturb a '${role}' claim`, async () => {
      const auth = makeAuth({ u: { role, aid: '' } })
      // A staff member edits their phone number on /profile.
      const r = await syncClaim('u', { role: 'superadmin', isActive: true, phone: '123' }, auth)
      expect(r.action).toBe('none')
      expect(auth.users.get('u')).toEqual({ role, aid: '' })
      expect(auth.writes.length).toBe(0)
    })
  }

  test('an observer with no crmUsers document at all is left alone', async () => {
    // `crm_directory.NOT_MIRRORED` — an observer deliberately has none, so the
    // trigger sees a deletion it must not act on.
    const auth = makeAuth({ u: { role: 'observer', aid: '' } })
    const r = await syncClaim('u', null, auth)
    expect(r.action).toBe('none')
    expect(auth.users.get('u').role).toBe('observer')
  })

  test('staff deactivation is the API’s job — the trigger does not do it', async () => {
    const auth = makeAuth({ u: { role: 'ops_admin', aid: '' } })
    await syncClaim('u', { role: 'ops_admin', isActive: false }, auth)
    expect(auth.users.get('u').role).toBe('ops_admin')
  })
})

describe('5. unrelated claims survive, and no-ops do not write', () => {
  test('a grant preserves a claim this module does not own', async () => {
    const auth = makeAuth({ u: { somethingElse: 'keep me' } })
    await syncClaim('u', agency(), auth)
    expect(auth.users.get('u')).toEqual({ somethingElse: 'keep me', role: 'agency', aid: 'AG7' })
  })

  test('so does a clear', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7', somethingElse: 'keep me' } })
    await syncClaim('u', null, auth)
    expect(auth.users.get('u')).toEqual({ somethingElse: 'keep me' })
  })

  test('an unchanged document writes nothing', async () => {
    const auth = makeAuth({ u: { role: 'agency', aid: 'AG7' } })
    const r = await syncClaim('u', agency(), auth)
    expect(r.action).toBe('none')
    expect(auth.writes.length).toBe(0)
  })

  test('deleting a document that never had a claim writes nothing', async () => {
    const auth = makeAuth({ u: {} })
    const r = await syncClaim('u', null, auth)
    expect(r.action).toBe('none')
    expect(auth.writes.length).toBe(0)
  })

  test('a missing auth user is skipped, not thrown — a throw would retry forever', async () => {
    const auth = makeAuth({})
    const r = await syncClaim('ghost', agency(), auth)
    expect(r.action).toBe('skipped')
  })
})

describe('6. idempotence under repetition', () => {
  test('ten identical writes produce exactly one claim write', async () => {
    const auth = makeAuth({ u: {} })
    for (let i = 0; i < 10; i++) await syncClaim('u', agency(), auth)
    expect(auth.writes.length).toBe(1)
    expect(auth.users.get('u')).toEqual({ role: 'agency', aid: 'AG7' })
  })

  test('a full lifecycle converges on the right claim however it is replayed', async () => {
    const auth = makeAuth({ u: {} })
    const steps = [
      agency(),                        // created
      agency({ agencyId: 'AG9' }),     // transferred
      agency({ agencyId: 'AG9', isActive: false }),  // suspended
      agency({ agencyId: 'AG9' }),     // reactivated
    ]
    for (const s of steps) await syncClaim('u', s, auth)
    expect(auth.users.get('u')).toEqual({ role: 'agency', aid: 'AG9' })
    // Replaying the last state changes nothing.
    const before = auth.writes.length
    await syncClaim('u', agency({ agencyId: 'AG9' }), auth)
    expect(auth.writes.length).toBe(before)
  })
})

/**
 * FX-12 (RF-05 / DUP-06) — when a code is redeemed and the person becomes a
 * Host, their OWN other open host applications are closed in the same write.
 *
 * The bug: a pending self-application stayed open beside the redeemed
 * invitation. /kyc showed a second application for somebody who was already a
 * Host, and refusing it later took the role away (RF-04, fixed by FX-01). The
 * backend's `grant_host` does the same for a reviewer's grant
 * (`backend/tests/test_fx_host_decisions.py`).
 *
 * REAL: `activateHost` over the shared fake Firestore, and the two pure
 * helpers it uses. ZIPPER_FUNCTIONS_LIB=<dir> loads another compiled `lib`.
 *
 * Run:  node --test test/fxHostSupersede.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
// Decision 15 (RC): `activateHost` now also asks whether BOTH contacts are
// verified on the account's Auth RECORD (contactProof.ts). This module's
// subject is superseding, not the contact rule, so U1's record holds both —
// an SMS-linked phone and a verified email on an account with no password
// method — matching the token below. `rcContactProof.test.js` runs the rule
// with records that are and are not verified.
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (uid !== 'U1') throw new Error('auth/user-not-found')
      return { uid, phoneNumber: '+919876543210', email: 'host@example.test', emailVerified: true, providerData: [] }
    },
  }),
})

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const H = require(path.join(LIB, 'hosts'))

const PHONE = '+919876543210'
const EMAIL = 'host@example.test'
const token = { phone_number: PHONE, email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'phone' } }
const call = (data, uid) => H.activateHost.run(data, { auth: { uid, token } })
async function refusal(p) { try { await p } catch (e) { return e } return null }

function world(invitation = {}) {
  db._docs.clear()
  db.seed('agencies/AG1', { referralCode: 'ABC123', status: 'approved', isActive: true })
  db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
  db.seed('users/U1', { name: 'Applicant' })
  db.seed('users/U2', { name: 'Somebody else' })
  db.seed('hostApplications/HA1', {
    referralCode: 'ABC123', agencyId: 'AG1', hostName: 'Applicant',
    applicantPhone: PHONE, applicantEmail: EMAIL, callRate: 300,
    isActivated: false, status: 'approved', kycStatus: 'approved',
    decidedByUid: 'uidReviewer', decidedAt: new Date(), ...invitation,
  })
  // U1's own self-application, still pending — the record this fix closes.
  db.seed('hostApplications/SELF1', { applicantUid: 'U1', agencyId: 'AG1', status: 'pending', kycStatus: 'submitted' })
  // Records that must NOT be touched.
  db.seed('hostApplications/SELF_OLD', { applicantUid: 'U1', agencyId: 'AG1', status: 'rejected', kycStatus: 'rejected', rejectionReason: 'earlier' })
  db.seed('hostApplications/SELF_U2', { applicantUid: 'U2', agencyId: 'AG1', status: 'pending', kycStatus: 'submitted' })
}

describe('the pure helpers', () => {
  test('only the person\'s OTHER pending, unredeemed applications are closed', () => {
    const ids = H.supersededApplications([
      { id: 'KEEP', data: { status: 'approved' } },
      { id: 'P', data: { status: 'pending' } },
      { id: 'NOSTATUS', data: {} },
      { id: 'R', data: { status: 'rejected' } },
      { id: 'A', data: { status: 'approved' } },
      { id: 'ACT', data: { status: 'pending', isActivated: true } },
      // Decision 15 (RC): approved by the Owner, waiting for contacts — open.
      { id: 'WAIT', data: { status: 'awaiting_verification' } },
    ], 'KEEP')
    expect(ids).toEqual(['P', 'NOSTATUS', 'WAIT'])
  })
  test('the stamp is a refusal in BOTH status fields, saying why', () => {
    const s = H.supersededStamp('HA1', 'T')
    expect([s.status, s.kycStatus, s.supersededBy]).toEqual(['rejected', 'rejected', 'HA1'])
    expect(String(s.rejectionReason).includes('became a Host through another application (HA1)')).toBe(true)
  })
})

describe('activateHost closes the person\'s other open applications', () => {
  beforeEach(() => world())

  test('a pending self-application is superseded in the same write as the activation', async () => {
    const r = await call({ referralCode: 'ABC123' }, 'U1')
    expect(r.alreadyActivated).toBe(false)
    expect(db.read('users/U1').isHost).toBe(true)
    const self = db.read('hostApplications/SELF1')
    expect([self.status, self.kycStatus, self.supersededBy]).toEqual(['rejected', 'rejected', 'HA1'])
    expect(r.supersededApplications).toEqual(['SELF1'])
  })

  test('an already-decided application of theirs, and another person\'s, are untouched', async () => {
    await call({ referralCode: 'ABC123' }, 'U1')
    expect(db.read('hostApplications/SELF_OLD').rejectionReason).toBe('earlier')
    expect(db.read('hostApplications/SELF_OLD').supersededBy).toBe(undefined)
    expect(db.read('hostApplications/SELF_U2').status).toBe('pending')
  })

  test('re-entering the code (redelivery) changes nothing further', async () => {
    await call({ referralCode: 'ABC123' }, 'U1')
    const before = db.read('hostApplications/SELF1')
    const again = await call({ referralCode: 'ABC123' }, 'U1')
    expect(again.alreadyActivated).toBe(true)
    expect(db.read('hostApplications/SELF1')).toEqual(before)
  })

  test('a refused activation closes nothing', async () => {
    world({ status: 'pending', decidedByUid: '', decidedAt: null })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1'))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('hostApplications/SELF1').status).toBe('pending')
  })
})

/**
 * RC — the confirmed role rule on the one path that grants Host without the
 * backend: `activateHost` (redeeming an agency's invitation).
 *
 *   A Sub-agency under main Agency X may ALSO be a Host directly under X —
 *   not under another agency, not under any sub-agency. A main Agency may not
 *   be a Host at all.
 *
 * `hostBlockedFor` (pure) and the shipped `activateHost` over the fake
 * Firestore and a scripted Auth (both contacts verified, so Decision 15 is not
 * what decides here).
 *
 * Run:  node --test test/rcRoleRules.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const PHONE = '+919876543210'
const EMAIL = 'host@example.test'
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] }),
  }),
})

const { hostBlockedFor, AGENCY_HOST_REFUSAL } = require('../lib/crmRoles')
const H = require('../lib/hosts')

describe('hostBlockedFor — pure', () => {
  const sub = { role: 'agency', roleStatus: { agency: 'approved' } }
  test('a Sub-agency of X may be a Host directly under X', () => {
    expect(hostBlockedFor(sub, { subParentId: 'X', invitationAgencyId: 'X', invitationAgencyIsMain: true })).toBe('')
  })
  test('…not under another agency', () => {
    expect(hostBlockedFor(sub, { subParentId: 'X', invitationAgencyId: 'Y', invitationAgencyIsMain: true }) !== '').toBe(true)
  })
  test('…and not under a sub-agency', () => {
    expect(hostBlockedFor(sub, { subParentId: 'X', invitationAgencyId: 'X', invitationAgencyIsMain: false }) !== '').toBe(true)
  })
  test('a main Agency is never a Host', () => {
    expect(hostBlockedFor(sub, { subParentId: '', invitationAgencyId: 'X', invitationAgencyIsMain: true })).toBe(AGENCY_HOST_REFUSAL)
  })
  test('staff stay refused as staff', () => {
    expect(hostBlockedFor({ role: 'ops_admin' }, { subParentId: 'X', invitationAgencyId: 'X', invitationAgencyIsMain: true }))
      .toBe('ZIPPER staff accounts cannot hold partner roles.')
  })
})

describe('activateHost with the role rule', () => {
  const token = { phone_number: PHONE, email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'phone' } }
  const call = (uid, code) => H.activateHost.run({ referralCode: code }, { auth: { uid, token } })
  async function refusal(p) { try { await p } catch (e) { return e } return null }

  beforeEach(() => {
    db._docs.clear()
    db.seed('agencies/X', { referralCode: 'XCODE1', status: 'approved', isActive: true, type: 'main', parentAgencyId: null })
    db.seed('agencies/Y', { referralCode: 'YCODE1', status: 'approved', isActive: true, type: 'main', parentAgencyId: null })
    db.seed('agencies/XSUB', { referralCode: 'XSUB01', status: 'approved', isActive: true, type: 'sub', parentAgencyId: 'X' })
    // U1's own Sub-agency, under X.
    db.seed('agencies/MYSUB', { status: 'approved', isActive: true, type: 'sub', parentAgencyId: 'X', crmUid: 'U1' })
    db.seed('crmUsers/U1', { uid: 'U1', role: 'agency', agencyId: 'MYSUB', status: 'approved', roleStatus: { agency: 'approved' }, isActive: true })
    db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
    db.seed('users/U1', { name: 'Applicant' })
    for (const [id, agencyId, code] of [['HA-X', 'X', 'XCODE1'], ['HA-Y', 'Y', 'YCODE1'], ['HA-XSUB', 'XSUB', 'XSUB01']]) {
      db.seed(`hostApplications/${id}`, {
        referralCode: code, agencyId, hostName: 'Applicant', applicantPhone: PHONE, applicantEmail: EMAIL,
        callRate: 300, isActivated: false, status: 'approved', kycStatus: 'approved',
        decidedByUid: 'uidReviewer', decidedAt: new Date(),
      })
    }
  })

  test('a Sub-agency of X redeems an invitation from X and becomes its Host', async () => {
    const r = await call('U1', 'XCODE1')
    expect(r.alreadyActivated).toBe(false)
    expect(db.read('users/U1').isHost).toBe(true)
    expect(db.read('users/U1').agencyId).toBe('X')
  })

  test('…but not an invitation from another agency', async () => {
    const e = await refusal(call('U1', 'YCODE1'))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('…nor one from a sub-agency (even of X)', async () => {
    const e = await refusal(call('U1', 'XSUB01'))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('a MAIN agency login is refused whatever the invitation', async () => {
    db.seed('agencies/MYMAIN', { status: 'approved', isActive: true, type: 'main', parentAgencyId: null, crmUid: 'U1' })
    db.seed('crmUsers/U1', { uid: 'U1', role: 'agency', agencyId: 'MYMAIN', status: 'approved', roleStatus: { agency: 'approved' }, isActive: true })
    const e = await refusal(call('U1', 'XCODE1'))
    expect(e && e.code).toBe('failed-precondition')
  })
})

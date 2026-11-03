/**
 * SECURITY-002 / AUTH-002 (Phase 1A) — the SHIPPED `activateHost`, executed.
 *
 * Exploit paths, each of which granted host status before Phase 1A:
 *   * forged status    — `status: 'approved'` written onto an application with
 *                        no server decision stamp;
 *   * forged code      — an application whose `referralCode` is not its
 *                        agency's code;
 *   * agency reassign  — an approved application re-pointed at another agency;
 *   * no approval      — a pending application;
 *   * typed identity   — the victim's phone/email supplied in the REQUEST or on
 *                        the user document instead of verified on the account;
 *   * guest            — an anonymous account.
 * And the legitimate path: a verified applicant redeems a server-approved code.
 *
 * Run:  node --test test/activateHostPhase1a.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

// Auth records: uid → { phoneNumber, email, emailVerified }
const records = new Map()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!records.has(uid)) throw new Error('auth/user-not-found')
      return { uid, ...records.get(uid) }
    },
  }),
})

const H = require('../lib/hosts')

const PHONE = '+919876543210'
const EMAIL = 'host@example.test'
const verifiedToken = { phone_number: PHONE, email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'phone' } }
const call = (data, uid, token) => H.activateHost.run(data, uid ? { auth: { uid, token } } : {})

async function refusal(promise) {
  try { await promise } catch (e) { return e }
  return null
}

function world({ app = {}, agency = {} } = {}) {
  db._docs.clear()
  records.clear()
  // Decision 15 (RC): the legitimate applicant's Auth RECORD holds both
  // contacts (an SMS-linked phone, a verified email, no password method) —
  // what the token below says. Tests about typed identity override it.
  records.set('U1', { phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] })
  db.seed('agencies/AG1', { referralCode: 'ABC123', status: 'approved', isActive: true, ...agency })
  db.seed('agencies/AG2', { referralCode: 'XYZ999', status: 'approved', isActive: true })
  db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
  db.seed('users/U1', { name: 'Applicant' })
  db.seed('hostApplications/HA1', {
    referralCode: 'ABC123', agencyId: 'AG1', hostName: 'Applicant',
    applicantPhone: PHONE, applicantEmail: EMAIL, callRate: 300,
    isActivated: false, status: 'approved', kycStatus: 'approved',
    decidedByUid: 'uidReviewer', decidedAt: new Date(), ...app,
  })
}

describe('activateHost — Phase 1A', () => {
  beforeEach(() => world())

  test('legitimate: a verified applicant redeems a server-approved invitation', async () => {
    const r = await call({ referralCode: 'abc123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(false)
    expect(db.read('users/U1').isHost).toBe(true)
    expect(db.read('hostApplications/HA1').activatedByUid).toBe('U1')
  })

  test('forged status: approved with no server decision stamp is refused', async () => {
    world({ app: { decidedByUid: '', decidedAt: null } })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('activation without approval (pending) is refused', async () => {
    world({ app: { status: 'pending', decidedByUid: '', decidedAt: null } })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('forged referral code: the application carries a code its agency does not own', async () => {
    world({ app: { referralCode: 'XYZ999' } })   // AG1's code is ABC123
    const e = await refusal(call({ referralCode: 'XYZ999' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('agency reassignment: an approved application re-pointed at another agency', async () => {
    world({ app: { agencyId: 'AG2' } })            // code ABC123 belongs to AG1
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('a suspended/unapproved agency cannot take hosts', async () => {
    world({ agency: { status: 'suspended', isActive: false } })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
  })

  test('typed identity in the REQUEST is ignored — the victim\'s invitation cannot be taken', async () => {
    const attackerToken = { phone_number: '+919800000000', firebase: { sign_in_provider: 'phone' } }
    records.set('U1', { phoneNumber: '+919800000000', email: '', emailVerified: false })
    const e = await refusal(call({ referralCode: 'ABC123', phone: PHONE, email: EMAIL }, 'U1', attackerToken))
    expect(e && e.code).toBe('permission-denied')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('typed contact on the USER DOCUMENT is ignored too', async () => {
    db.seed('users/U1', { name: 'x', phoneNumber: PHONE, email: EMAIL })
    const attackerToken = { phone_number: '+919800000000', firebase: { sign_in_provider: 'phone' } }
    records.set('U1', { phoneNumber: '+919800000000', email: '', emailVerified: false })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', attackerToken))
    expect(e && e.code).toBe('permission-denied')
  })

  test('a verified half from the Auth RECORD (fresh bind, stale token) still works', async () => {
    const phoneOnly = { phone_number: PHONE, firebase: { sign_in_provider: 'phone' } }
    records.set('U1', { phoneNumber: PHONE, email: EMAIL, emailVerified: true })
    const r = await call({ referralCode: 'ABC123' }, 'U1', phoneOnly)
    expect(r.alreadyActivated).toBe(false)
  })

  test('an UNVERIFIED email on the Auth record does not count', async () => {
    // QA #51 changed WHAT happens to this person, not whether the address
    // counts: the verified phone used to be refused outright (that refusal was
    // the "Details don't match the agency record" bug); it now claims the
    // invitation and waits. The unverified address still proves nothing — it
    // is reported as missing, and no Host role starts.
    const phoneOnly = { phone_number: PHONE, firebase: { sign_in_provider: 'phone' } }
    records.set('U1', { phoneNumber: PHONE, email: EMAIL, emailVerified: false })
    const r = await call({ referralCode: 'ABC123' }, 'U1', phoneOnly)
    expect(r.awaitingVerification).toBe(true)
    expect(r.missing).toEqual(['email'])
    expect(db.read('users/U1').isHost).toBe(undefined)
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
    expect(db.read('hostApplications/HA1').status).toBe('awaiting_verification')
  })

  test('AUTH-002: a guest is refused before any lookup', async () => {
    const e = await refusal(call({ referralCode: 'ABC123', phone: PHONE, email: EMAIL }, 'U1',
      { firebase: { sign_in_provider: 'anonymous' } }))
    expect(e && e.code).toBe('permission-denied')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })

  test('unauthenticated is refused', async () => {
    const e = await refusal(call({ referralCode: 'ABC123' }))
    expect(e && e.code).toBe('unauthenticated')
  })
})

// ══ GOV phase: B09 (a second invitation resets nothing), B04/C1 (revoked) ════

const { Timestamp } = require('./fakeFirestore')
const { HOST_REVOKED_REFUSAL } = require('../lib/hostEligibility')
const T0 = 1_790_000_000_000
const T1 = 1_800_000_000_000
const check = (data, uid, token) => H.checkReferralCode.run(data, { auth: { uid, token } })

/**
 * U1 is ALREADY a verified Host of AG1, from invitation HA0, with a roster row
 * and a verified record. HA1 (from `world`) is a second invitation from the
 * same agency under the same code: approved, unredeemed, at a different rate.
 */
function hostWorld(duplicate = {}) {
  world({ app: duplicate })
  db.seed('users/U1', {
    name: 'Applicant', isHost: true, agencyId: 'AG1', callRateBeans: 450,
    isVerifiedHost: true, hostActivatedAt: Timestamp.fromMillis(T0),
  })
  db.seed('hostApplications/HA0', {
    referralCode: 'ABC123', agencyId: 'AG1', hostName: 'Applicant',
    applicantPhone: PHONE, applicantEmail: EMAIL, callRate: 450,
    isActivated: true, activatedByUid: 'U1', status: 'approved', kycStatus: 'approved',
    decidedByUid: 'uidReviewer', decidedAt: new Date(),
  })
  db.seed('hostVerification/U1', {
    uid: 'U1', status: 'verified', attemptCount: 2, agencyId: 'AG1', applicationId: 'HA0',
    agencyPhotoUrl: 'agency.jpg', captureUrl: 'hostVerification/U1/attempts/a1.jpg',
    verifiedAt: Timestamp.fromMillis(T0 + 1000),
  })
  db.seed('agencies/AG1/agencyHosts/U1', {
    uid: 'U1', name: 'Applicant', agencyId: 'AG1', applicationId: 'HA0',
    callRateBeans: 450, joinedAt: Timestamp.fromMillis(T0),
  })
}

/** Everything a re-entry must leave exactly as it was. */
const untouched = () => ({
  user: db.read('users/U1'),
  ver: db.read('hostVerification/U1'),
  rosterRate: db.read('agencies/AG1/agencyHosts/U1').callRateBeans,
  rosterApp: db.read('agencies/AG1/agencyHosts/U1').applicationId,
  rosterJoined: db.read('agencies/AG1/agencyHosts/U1').joinedAt.toMillis(),
})

describe('B09 — a second invitation from the same agency resets nothing', () => {
  test('an approved duplicate is linked to the existing Host; badge, rate and verification stay', async () => {
    hostWorld()
    const before = untouched()
    const r = await call({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(true)
    expect(r.agencyId).toBe('AG1')
    expect(untouched()).toEqual(before)
    expect(db.read('users/U1').isVerifiedHost).toBe(true)
    expect(db.read('users/U1').callRateBeans).toBe(450)
    expect(db.read('hostVerification/U1').status).toBe('verified')
    // The duplicate is used and linked, so the CRM shows one person.
    const dup = db.read('hostApplications/HA1')
    expect(dup.isActivated).toBe(true)
    expect(dup.activatedByUid).toBe('U1')
    expect(dup.linkedToExistingHost).toBe(true)
  })

  test('an undecided duplicate is left as it is, and still resets nothing', async () => {
    hostWorld({ status: 'pending', decidedByUid: '', decidedAt: null })
    const before = untouched()
    const r = await call({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(true)
    expect(untouched()).toEqual(before)
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
    expect(db.read('hostApplications/HA1').activatedByUid).toBe(undefined)
  })

  test('a rejected duplicate stays rejected and unused, and resets nothing', async () => {
    hostWorld({ status: 'rejected' })
    const before = untouched()
    const r = await call({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(true)
    expect(untouched()).toEqual(before)
    expect(db.read('hostApplications/HA1').status).toBe('rejected')
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
  })

  test('re-entering one\'s own redeemed code (no duplicate) resets nothing', async () => {
    hostWorld()
    db._docs.delete('hostApplications/HA1')
    const before = untouched()
    const r = await call({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(true)
    expect(untouched()).toEqual(before)
  })

  test('a Host of ANOTHER agency is still refused, and the invitation is not linked', async () => {
    hostWorld()
    db.seed('users/U1', { name: 'Applicant', isHost: true, agencyId: 'AG2', isVerifiedHost: true })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/U1').agencyId).toBe('AG2')
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
  })
})

describe('C1 (B04) — a revoked Host is not a new applicant', () => {
  /** The shape `revoke_host` leaves: isHost false, both stamps, agency kept. */
  const revoked = (extra = {}) => db.seed('users/U1', {
    name: 'Applicant', isHost: false, agencyId: 'AG1', isVerifiedHost: true, callRateBeans: 450,
    hostActivatedAt: Timestamp.fromMillis(T0),
    hostRemovedAt: Timestamp.fromMillis(T1), hostRevokedAt: Timestamp.fromMillis(T1),
    ...extra,
  })

  test('activateHost refuses with C1\'s sentence and ROLE_REVOKED; nothing is written', async () => {
    world()
    revoked()
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe(HOST_REVOKED_REFUSAL)
    expect(e.details && e.details.code).toBe('ROLE_REVOKED')
    expect(db.read('users/U1').isHost).toBe(false)
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
    expect(db.has('hostVerification/U1')).toBe(false)
    expect(db.has('agencies/AG1/agencyHosts/U1')).toBe(false)
  })

  test('…including through their own old, already-redeemed invitation (no roster repair)', async () => {
    world({ app: { isActivated: true, activatedByUid: 'U1' } })
    revoked()
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.details && e.details.code).toBe('ROLE_REVOKED')
    expect(db.has('agencies/AG1/agencyHosts/U1')).toBe(false)
  })

  test('checkReferralCode asks the same question and carries the sentence', async () => {
    world()
    revoked()
    const r = await check({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r).toEqual({ valid: false, reason: 'role_revoked', code: 'ROLE_REVOKED', message: HOST_REVOKED_REFUSAL })
  })

  test('a Host RESTORED after the revocation is a Host again (re-entry harmless)', async () => {
    hostWorld()
    db.seed('users/U1', {
      name: 'Applicant', isHost: true, agencyId: 'AG1', isVerifiedHost: true, callRateBeans: 450,
      hostRevokedAt: Timestamp.fromMillis(T1), hostRemovedAt: Timestamp.fromMillis(T1),
      hostRestoredAt: Timestamp.fromMillis(T1 + 60_000),
    })
    const r = await call({ referralCode: 'ABC123' }, 'U1', verifiedToken)
    expect(r.alreadyActivated).toBe(true)
    expect(db.read('users/U1').isVerifiedHost).toBe(true)
    expect((await check({ referralCode: 'ABC123' }, 'U1', verifiedToken)).reason).not.toBe('role_revoked')
  })

  test('a REVOKED Agency still blocks Host through a referral code (role table)', async () => {
    world()
    db.seed('crmUsers/U1', { role: 'agency', roles: ['agency'], roleStatus: { agency: 'revoked' }, isActive: false })
    const e = await refusal(call({ referralCode: 'ABC123' }, 'U1', verifiedToken))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('An Agency or Sub-agency cannot also be a Host.')
    expect(db.read('users/U1').isHost).toBe(undefined)
  })
})

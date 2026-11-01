/**
 * Decision 15 (RC) — the Functions side of "approval is not activation until
 * BOTH contacts are verified".
 *
 * Runs the REAL compiled code (lib/) against the in-memory Firestore, a
 * scripted Firebase Auth and a captured mail transport. Service-level, NOT an
 * end-to-end test: no emulator, no network.
 *
 *   * `contactProof` — the same matrix as backend/tests/test_rc_contact_verification.py,
 *     so the two services cannot disagree about who is verified;
 *   * `requestLoginEmailCode` / `verifyLoginEmailCode` — a CRM partner login
 *     confirms the address ALREADY on its Auth record with our 6-digit code:
 *     `emailVerified` set, the server ledger written (`email_code`), nothing
 *     written to users/{uid}, no address accepted from the client, only a
 *     partner login may ask, and a code issued for one purpose is not
 *     accepted by the other;
 *   * `verifyEmailBindCode` writes the same ledger entry;
 *   * `activateHost` — a password account whose address Firebase marked
 *     verified (a reset link) does not START a Host role without our code;
 *     with it, it does.
 *
 * Run:  node --test test/rcContactProof.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()

const authState = { records: new Map(), updates: [] }
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      const r = authState.records.get(uid)
      if (!r) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e }
      return r
    },
    getUserByEmail: async (email) => {
      for (const r of authState.records.values()) {
        if (String(r.email ?? '').toLowerCase() === email) return r
      }
      const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e
    },
    updateUser: async (uid, patch) => {
      authState.updates.push({ uid, ...patch })
      const r = authState.records.get(uid) ?? { uid, providerData: [] }
      authState.records.set(uid, { ...r, ...patch })
    },
    createCustomToken: async (uid) => `custom-${uid}`,
    revokeRefreshTokens: async () => undefined,
  }),
})

const CP = require('../lib/contactProof')
const OTP = require('../lib/emailOtp')
const MAIL = require('../lib/mail')
const H = require('../lib/hosts')

let outbox = []
MAIL.setMailTransportForTests(async (m) => { outbox.push(m) })
const lastCode = () => {
  const m = outbox[outbox.length - 1]
  return m ? (m.text.match(/code is (\d{6})/) || [])[1] : undefined
}

const realNow = Date.now
let clock = 1_800_000_000_000

async function refusal(p) { try { await p } catch (e) { return e } return null }
const pw = (email) => [{ providerId: 'password', email }]

beforeEach(() => {
  db._docs.clear()
  authState.records.clear()
  authState.updates = []
  outbox = []
  clock = 1_800_000_000_000
  Date.now = () => clock
})
afterEach(() => { Date.now = realNow })

// ══════════════════════════════════════════════════════════════════════════
describe('contactProof — the same answers as the backend', () => {
  const cases = [
    ['neither', {}, false, ['phone', 'email']],
    ['phone only', { phone: '+910000000001' }, false, ['email']],
    ['app account, verified email, no password method', { authEmail: 'a@x.test', emailVerified: true }, false, ['phone']],
    ['both on an app account', { phone: '+91', authEmail: 'a@x.test', emailVerified: true }, true, []],
    ['credentials SENT to a password login (not verified)',
      { phone: '+91', authEmail: 'c@x.test', emailVerified: false, providers: pw('c@x.test') }, false, ['email']],
    ['reset completed on a password login (Firebase says verified) — not our proof',
      { phone: '+91', authEmail: 'c@x.test', emailVerified: true, providers: pw('c@x.test') }, false, ['email']],
    ['…with our code recorded for that address',
      { phone: '+91', authEmail: 'c@x.test', emailVerified: true, providers: pw('c@x.test'), ledgerAddress: 'c@x.test' }, true, []],
    ['…our code recorded for a DIFFERENT address',
      { phone: '+91', authEmail: 'new@x.test', emailVerified: true, providers: pw('new@x.test'), ledgerAddress: 'old@x.test' }, false, ['email']],
    ['a linked Google sign-in with the same address',
      { phone: '+91', authEmail: 'g@x.test', emailVerified: true,
        providers: [{ providerId: 'password', email: 'g@x.test' }, { providerId: 'google.com', email: 'g@x.test' }] }, true, []],
    ['a Google sign-in for another address',
      { phone: '+91', authEmail: 'g@x.test', emailVerified: true,
        providers: [{ providerId: 'password', email: 'g@x.test' }, { providerId: 'google.com', email: 'other@x.test' }] }, false, ['email']],
    ['an unverified address on an app account', { phone: '+91', authEmail: 'u@x.test', emailVerified: false }, false, ['email']],
  ]
  for (const [label, input, complete, missing] of cases) {
    test(label, () => {
      const p = CP.contactProof(input)
      expect(p.complete).toBe(complete)
      expect(p.missing).toEqual(missing)
    })
  }
  test('an unproved address is reported as such, for the screen', () => {
    expect(CP.contactProof({ authEmail: 'c@x.test', emailVerified: true, providers: pw('c@x.test') }).emailUnproved).toBe(true)
    expect(CP.contactProof({}).emailUnproved).toBe(false)
  })
  test('contactProofFor reads the Auth record and the ledger; a missing record proves nothing', async () => {
    expect((await CP.contactProofFor('nobody')).complete).toBe(false)
    authState.records.set('P', { uid: 'P', phoneNumber: '+91', email: 'p@x.test', emailVerified: true, providerData: pw('p@x.test') })
    expect((await CP.contactProofFor('P')).missing).toEqual(['email'])
    db.seed('contactVerifications/P', { email: { address: 'p@x.test', method: 'email_code' } })
    const p = await CP.contactProofFor('P')
    expect([p.complete, p.emailMethod]).toEqual([true, 'email_code'])
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('a CRM partner login confirms its own address by code', () => {
  const ctx = (uid) => ({ auth: { uid, token: { firebase: { sign_in_provider: 'password' } } } })
  const request = (uid, data = {}) => OTP.requestLoginEmailCode.run(data, ctx(uid))
  const verify = (uid, code) => OTP.verifyLoginEmailCode.run({ code }, ctx(uid))

  function partnerLogin(uid, { role = 'agency', email = 'crm@x.test', verified = false } = {}) {
    authState.records.set(uid, { uid, email, emailVerified: verified, providerData: pw(email) })
    db.seed(`crmUsers/${uid}`, { uid, role, status: 'awaiting_verification', email })
  }

  test('the code goes to the address on the login, and confirming it writes the proof', async () => {
    partnerLogin('L1')
    const sent = await request('L1', { email: 'attacker@x.test' })   // any address in data is ignored
    expect(sent.status).toBe('sent')
    expect(outbox.length).toBe(1)
    expect(outbox[0].to).toBe('crm@x.test')
    expect(outbox[0].text.includes('partner portal')).toBe(true)
    const ch = db.read('emailOtpChallenges/L1')
    expect(ch.purpose).toBe('login_email')
    expect(JSON.stringify(ch).includes(lastCode())).toBe(false)   // only a salted HMAC is stored

    const r = await verify('L1', lastCode())
    expect(r.status).toBe('verified')
    expect(authState.records.get('L1').emailVerified).toBe(true)
    const ledger = db.read('contactVerifications/L1')
    expect([ledger.email.address, ledger.email.method]).toEqual(['crm@x.test', 'email_code'])
    expect(db.read('users/L1')).toBe(undefined)                     // no app document is written
    expect((await CP.contactProofFor('L1')).emailVerified).toBe(true)
  })

  test('a wrong code counts against the limit and proves nothing', async () => {
    partnerLogin('L2')
    await request('L2')
    const wrong = lastCode() === '000000' ? '111111' : '000000'
    const e = await refusal(verify('L2', wrong))
    expect(e && e.code).toBe('invalid-argument')
    expect(db.read('contactVerifications/L2')).toBe(undefined)
    expect(db.read('emailOtpChallenges/L2').attempts).toBe(1)
  })

  test('only a partner login may ask', async () => {
    authState.records.set('S1', { uid: 'S1', email: 'staff@x.test', emailVerified: true, providerData: pw('staff@x.test') })
    db.seed('crmUsers/S1', { uid: 'S1', role: 'ops_admin' })
    expect((await refusal(request('S1')))?.code).toBe('permission-denied')
    authState.records.set('A1', { uid: 'A1', email: 'app@x.test', emailVerified: true, providerData: [] })
    expect((await refusal(request('A1')))?.code).toBe('permission-denied')
    expect(outbox.length).toBe(0)
  })

  test('a login with no address is told so, and nothing is sent', async () => {
    authState.records.set('L3', { uid: 'L3', providerData: [] })
    db.seed('crmUsers/L3', { uid: 'L3', role: 'seller' })
    expect((await refusal(request('L3')))?.code).toBe('failed-precondition')
    expect(outbox.length).toBe(0)
  })

  test('a code issued to BIND an app address is not a login proof, and the reverse', async () => {
    partnerLogin('L4', { email: 'l4@x.test' })
    // A bind challenge for the same address on the same uid.
    await OTP.requestEmailBindCode.run({ email: 'l4@x.test' },
      { auth: { uid: 'L4', token: { phone_number: '+910000000004', firebase: { sign_in_provider: 'phone' } } } })
    const bindCode = lastCode()
    expect(db.read('emailOtpChallenges/L4').purpose).toBe('bind')
    expect((await refusal(verify('L4', bindCode)))?.code).toBe('failed-precondition')
    expect(db.read('contactVerifications/L4')).toBe(undefined)

    clock += 61_000
    await request('L4')
    const loginCode = lastCode()
    const e = await refusal(OTP.verifyEmailBindCode.run({ email: 'l4@x.test', code: loginCode },
      { auth: { uid: 'L4', token: { phone_number: '+910000000004', firebase: { sign_in_provider: 'phone' } } } }))
    expect(e && e.code).toBe('failed-precondition')
  })

  test('unauthenticated is refused', async () => {
    const e = await refusal(OTP.requestLoginEmailCode.run({}, {}))
    expect(e && e.code).toBe('unauthenticated')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('the app\'s bind flow records the same proof', () => {
  test('verifyEmailBindCode writes contactVerifications/{uid} with method email_code', async () => {
    const uid = 'G1'
    db.seed(`users/${uid}`, { name: 'Guest abc' })
    authState.records.set(uid, { uid, phoneNumber: '+910000000005', providerData: [] })
    const token = { auth_time: 2000, phone_number: '+910000000005', firebase: { sign_in_provider: 'phone' } }
    await OTP.requestEmailBindCode.run({ email: 'g1@x.test' }, { auth: { uid, token } })
    const r = await OTP.verifyEmailBindCode.run({ email: 'g1@x.test', code: lastCode() }, { auth: { uid, token } })
    expect(r.status).toBe('bound')
    const ledger = db.read(`contactVerifications/${uid}`)
    expect([ledger.email.address, ledger.email.method]).toEqual(['g1@x.test', 'email_code'])
    expect((await CP.contactProofFor(uid)).complete).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('activateHost starts a Host role only with BOTH contacts proved', () => {
  const PHONE = '+919876543210'
  const EMAIL = 'host@example.test'
  const token = { phone_number: PHONE, email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'password' } }
  const call = (uid) => H.activateHost.run({ referralCode: 'ABC123' }, { auth: { uid, token } })

  function world() {
    db.seed('agencies/AG1', { referralCode: 'ABC123', status: 'approved', isActive: true })
    db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
    db.seed('users/U1', { name: 'Applicant' })
    db.seed('hostApplications/HA1', {
      referralCode: 'ABC123', agencyId: 'AG1', hostName: 'Applicant',
      applicantPhone: PHONE, applicantEmail: EMAIL, callRate: 300,
      isActivated: false, status: 'approved', kycStatus: 'approved',
      decidedByUid: 'uidReviewer', decidedAt: new Date(),
    })
  }

  test('a password account whose address Firebase marked verified (reset) is refused, machine-readably', async () => {
    world()
    authState.records.set('U1', { uid: 'U1', phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: pw(EMAIL) })
    const e = await refusal(call('U1'))
    expect(e && e.code).toBe('failed-precondition')
    expect(e && e.details && e.details.code).toBe('CONTACT_VERIFICATION_REQUIRED')
    expect(e && e.details && e.details.missing).toEqual(['email'])
    expect(db.read('users/U1').isHost).toBe(undefined)
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
  })

  test('with our code recorded for that address, the same redemption starts the role', async () => {
    world()
    authState.records.set('U1', { uid: 'U1', phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: pw(EMAIL) })
    db.seed('contactVerifications/U1', { email: { address: EMAIL, method: 'email_code' } })
    const r = await call('U1')
    expect(r.alreadyActivated).toBe(false)
    expect(db.read('users/U1').isHost).toBe(true)
  })

  test('re-entering an already-redeemed code (a roster repair, not a start) is not blocked', async () => {
    world()
    db.seed('hostApplications/HA1', {
      ...db.read('hostApplications/HA1'), isActivated: true, activatedByUid: 'U1',
    })
    db.seed('users/U1', { name: 'Applicant', isHost: true, agencyId: 'AG1' })
    authState.records.set('U1', { uid: 'U1', phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: pw(EMAIL) })
    const r = await call('U1')
    expect(r.alreadyActivated).toBe(true)
  })
})

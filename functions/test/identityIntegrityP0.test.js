/**
 * P0-5 — identity integrity in the callables (AUTHN-2, AUTHN-3 interim).
 *
 * AUTHN-2: an email on a token proves nothing until Firebase has seen it
 * confirmed. CRM email/password sign-up is open, so an unverified token can
 * carry any address that has no account yet; `findExistingAccount`,
 * `bindVerifiedIdentity`, the host guest refusal and `resolveIdentity` all
 * treated such a token as proof.
 *
 * AUTHN-3 (interim, until D1/D2): `bindVerifiedIdentity` overwrote a contact
 * already on the caller's account with `set(merge)` — no approval, no proof of
 * the old contact, no record. It now refuses a replacement (a respelling of
 * the same number is not one), records the attempt, and writes nothing.
 *
 * Run:  node --test test/identityIntegrityP0.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [{ providerId: 'password' }] }),
    createCustomToken: async (uid) => `token-${uid}`,
  }),
})

const ID = require('../lib/identity')
const HE = require('../lib/hostEligibility')

const ctx = (uid, token) => ({ auth: { uid, token: { auth_time: 2000, ...token } } })
const pwd = (email, verified) => ({
  email, email_verified: verified, firebase: { sign_in_provider: 'password' },
})
const phoneTok = (phone) => ({ phone_number: phone, firebase: { sign_in_provider: 'phone' } })

async function refusal(promise) {
  try { await promise } catch (e) { return e }
  return null
}

beforeEach(() => { db._docs.clear() })

describe('AUTHN-2: an unverified email proves nothing', () => {
  test('findExistingAccount refuses an UNVERIFIED address on the token', async () => {
    db.seed('users/V', { name: 'victim', email: 'v@example.test' })
    const e = await refusal(ID.findExistingAccount.run({ email: 'v@example.test' }, ctx('A', pwd('v@example.test', false))))
    expect(e && e.code).toBe('permission-denied')
  })
  test('findExistingAccount answers for a VERIFIED address (control)', async () => {
    db.seed('users/V', { name: 'victim', email: 'v@example.test' })
    const r = await ID.findExistingAccount.run({ email: 'v@example.test' }, ctx('A', pwd('v@example.test', true)))
    expect(r.accounts.length).toBe(1)
  })
  test('bindVerifiedIdentity refuses an UNVERIFIED address', async () => {
    db.seed('users/A', { name: 'a' })
    const e = await refusal(ID.bindVerifiedIdentity.run({ email: 'x@example.test' }, ctx('A', pwd('x@example.test', false))))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/A').email).toBe(undefined)
  })
  test('bindVerifiedIdentity binds a VERIFIED address (control)', async () => {
    db.seed('users/A', { name: 'a' })
    const r = await ID.bindVerifiedIdentity.run({ email: 'x@example.test' }, ctx('A', pwd('x@example.test', true)))
    expect(r.bound).toBe(true)
    expect(db.read('users/A').email).toBe('x@example.test')
  })
  test('a host applicant with only an UNVERIFIED email is a guest', () => {
    expect(HE.guestRefusal(pwd('x@example.test', false)) !== '').toBe(true)
    expect(HE.guestRefusal(pwd('x@example.test', true))).toBe('')
    expect(HE.guestRefusal(phoneTok('+919800000001'))).toBe('')
  })
  test('resolveIdentity still asks a host for an email when the token\'s is unverified', async () => {
    db.seed('users/H', { name: 'h', isHost: true, isProfileComplete: true, phoneNumber: '+919800000001' })
    const r = await ID.resolveIdentity.run({}, ctx('H', pwd('h@example.test', false)))
    expect(r.requiresEmail).toBe(true)
    const v = await ID.resolveIdentity.run({}, ctx('H', pwd('h@example.test', true)))
    expect(v.requiresEmail).toBe(false)
  })
})

describe('C7 (B14): the partner part of needsBoth counts APPROVED capabilities only', () => {
  // Phone sign-in, no email anywhere: the partner's missing half is the email.
  const phoneOnly = () => ctx('P', phoneTok('+919800000009'))
  const seedPartner = (crm, user = {}) => {
    db.seed('users/P', { name: 'p', isProfileComplete: true, phoneNumber: '+919800000009', ...user })
    db.seed('crmUsers/P', { uid: 'P', isActive: true, ...crm })
  }

  for (const [label, crm] of [
    ['a PENDING agency', { role: 'agency', roles: ['agency'], roleStatus: { agency: 'pending' } }],
    ['a REJECTED agency', { role: 'agency', roles: ['agency'], roleStatus: { agency: 'rejected' } }],
    ['a REVOKED agency', { role: 'agency', roles: ['agency'], roleStatus: { agency: 'revoked' }, isActive: false }],
    ['a pending coin seller (login status only)', { role: 'seller', status: 'pending' }],
    ['a suspended agency', { role: 'agency', roleStatus: { agency: 'suspended' } }],
  ]) {
    test(`${label} is not asked for contacts`, async () => {
      seedPartner(crm)
      const r = await ID.resolveIdentity.run({}, phoneOnly())
      expect(r.requiresEmail).toBe(false)
      expect(r.requiresPhone).toBe(false)
      expect(r.crmRole).toBe(crm.role)   // the role string itself is still reported as before
    })
  }

  test('a stale isAgent/isSeller copy on the user document does not count', async () => {
    db.seed('users/P', { name: 'p', phoneNumber: '+919800000009', isAgent: true, isSeller: true })
    const r = await ID.resolveIdentity.run({}, phoneOnly())
    expect(r.requiresEmail).toBe(false)
  })

  test('an APPROVED agency missing an email is asked for it', async () => {
    seedPartner({ role: 'agency', roles: ['agency'], roleStatus: { agency: 'approved' } })
    const r = await ID.resolveIdentity.run({}, phoneOnly())
    expect(r.requiresEmail).toBe(true)
    expect(r.requiresPhone).toBe(false)
  })

  test('an APPROVED seller on a Google sign-in is asked for the phone', async () => {
    db.seed('users/P', { name: 'p', email: 's@example.test' })
    db.seed('crmUsers/P', { uid: 'P', role: 'seller', status: 'approved', isActive: true })
    const r = await ID.resolveIdentity.run({}, ctx('P', {
      email: 's@example.test', email_verified: true, firebase: { sign_in_provider: 'google.com' },
    }))
    expect(r.requiresPhone).toBe(true)
    expect(r.requiresEmail).toBe(false)
  })

  test('a dual login with a revoked agency and an approved seller still owes both', async () => {
    seedPartner({ role: 'agency', roles: ['agency', 'seller'], roleStatus: { agency: 'revoked', seller: 'approved' } })
    expect((await ID.resolveIdentity.run({}, phoneOnly())).requiresEmail).toBe(true)
  })

  test('hosts and staff are unchanged', async () => {
    // A host owes both whatever the CRM says.
    db.seed('users/P', { name: 'p', isHost: true, phoneNumber: '+919800000009' })
    expect((await ID.resolveIdentity.run({}, phoneOnly())).requiresEmail).toBe(true)
    // Staff owe both whatever their login's state — as before.
    db._docs.clear()
    seedPartner({ role: 'ops_admin' })
    expect((await ID.resolveIdentity.run({}, phoneOnly())).requiresEmail).toBe(true)
    db._docs.clear()
    seedPartner({ role: 'app_member', isActive: false })
    expect((await ID.resolveIdentity.run({}, phoneOnly())).requiresEmail).toBe(true)
    // An ordinary user owes nothing.
    db._docs.clear()
    db.seed('users/P', { name: 'p', phoneNumber: '+919800000009' })
    expect((await ID.resolveIdentity.run({}, phoneOnly())).requiresEmail).toBe(false)
  })
})

describe('AUTHN-3 (interim): a contact already on the account is not replaced', () => {
  test('a DIFFERENT phone is refused, recorded, and nothing is written', async () => {
    db.seed('users/A', { name: 'a', phoneNumber: '+919800000001', phoneKey: '919800000001' })
    const e = await refusal(ID.bindVerifiedIdentity.run({ phone: '+919800000002' }, ctx('A', phoneTok('+919800000002'))))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.details && e.details.reason).toBe('contact_replacement_refused')
    expect(db.read('users/A').phoneNumber).toBe('+919800000001')
    const audit = [...db._docs.entries()].filter(([k]) => k.startsWith('identityChangeRefusals/'))
    expect(audit.length).toBe(1)
    expect(audit[0][1].fields).toEqual(['phone'])
    expect(audit[0][1].uid).toBe('A')
  })
  test('a DIFFERENT email is refused', async () => {
    db.seed('users/A', { name: 'a', email: 'old@example.test' })
    const e = await refusal(ID.bindVerifiedIdentity.run({ email: 'new@example.test' }, ctx('A', pwd('new@example.test', true))))
    expect(e && e.code).toBe('failed-precondition')
    expect(db.read('users/A').email).toBe('old@example.test')
  })
  test('binding the SAME phone again is fine (control)', async () => {
    db.seed('users/A', { name: 'a', phoneNumber: '+919800000001', phoneKey: '919800000001' })
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000001' }, ctx('A', phoneTok('+919800000001')))
    expect(r.bound).toBe(true)
  })
  test('a legacy bare spelling of the SAME number is not a replacement (control)', async () => {
    db.seed('users/A', { name: 'a', phoneNumber: '9800000001', phoneKey: '9800000001' })
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000001' }, ctx('A', phoneTok('+919800000001')))
    expect(r.bound).toBe(true)
    expect(db.read('users/A').phoneNumber).toBe('+919800000001')
  })
  test('the same email in another case is not a replacement (control)', async () => {
    db.seed('users/A', { name: 'a', email: 'Me@Example.test' })
    const r = await ID.bindVerifiedIdentity.run({ email: 'me@example.test' }, ctx('A', pwd('me@example.test', true)))
    expect(r.bound).toBe(true)
  })
  test('an account with NO contact yet binds as before (control)', async () => {
    db.seed('users/A', { name: 'a' })
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000003' }, ctx('A', phoneTok('+919800000003')))
    expect(r.bound).toBe(true)
    expect(db.read('users/A').phoneKey).toBe('919800000003')
  })
})

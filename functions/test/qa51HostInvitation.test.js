/**
 * QA #51 (3 Nov 2026) — "An invited host cannot use the agency code".
 *
 * The agency invites a host by phone AND e-mail. A new PHONE sign-up has a
 * verified number and no e-mail, and `applicationsFor` looked the invitation
 * up by the verified e-mail only — so every invited host was told "Details
 * don't match the agency record for this code" at sign-up.
 *
 * Runs the SHIPPED `checkReferralCode` / `activateHost` from lib/ against the
 * in-memory Firestore and a scripted Firebase Auth. Pinned here:
 *
 *   * the original failure, as a regression: a phone-only invited host now
 *     FINDS the invitation, is told which contact is still missing (masked),
 *     and CLAIMS it — the role does not start (Decision 15: both contacts);
 *   * the claim is the account's alone: nobody else can claim or redeem it,
 *     a contradicting verified contact is refused, nothing typed counts;
 *   * expired / revoked / used / mismatched invitations are refused correctly
 *     and write nothing;
 *   * with both contacts verified the redemption is unchanged.
 *
 * Run:  node --test test/qa51HostInvitation.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

// Auth records: uid → { phoneNumber, email, emailVerified, providerData }
const records = new Map()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!records.has(uid)) throw new Error('auth/user-not-found')
      return { uid, providerData: [], ...records.get(uid) }
    },
  }),
})

const H = require('../lib/hosts')

const PHONE = '+919990010004'
const INVITED_PHONE_TYPED = '+91 99900 10004'   // as the CRM stored it
const EMAIL = 'invited.host@example.test'
const CODE = 'QAAGWYYP'

const phoneToken = (phone = PHONE) => ({ phone_number: phone, firebase: { sign_in_provider: 'phone' } })
const googleToken = (email = EMAIL) => ({ email, email_verified: true, firebase: { sign_in_provider: 'google.com' } })
const bothToken = { phone_number: PHONE, email: EMAIL, email_verified: true, firebase: { sign_in_provider: 'phone' } }

const ctx = (uid, token) => ({ auth: { uid, token } })
const check = (uid, token, data = {}) => H.checkReferralCode.run({ referralCode: CODE.toLowerCase(), ...data }, ctx(uid, token))
const redeem = (uid, token, data = {}) => H.activateHost.run({ referralCode: CODE, ...data }, ctx(uid, token))

async function refusal(promise) {
  try { await promise } catch (e) { return e }
  return null
}

function world({ app = {}, agency = {} } = {}) {
  db._docs.clear()
  records.clear()
  db.seed('agencies/AG1', { referralCode: CODE, status: 'approved', isActive: true, agencyName: 'QA Agency CRM', ...agency })
  db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
  db.seed('hostApplications/INV1', {
    referralCode: CODE, agencyId: 'AG1', agencyName: 'QA Agency CRM', hostName: 'Invited Host',
    applicantPhone: INVITED_PHONE_TYPED, applicantEmail: EMAIL, callRate: 300,
    photoUrl: 'https://x/agency-photo.jpg',
    isActivated: false, status: 'approved', kycStatus: 'approved',
    decidedByUid: 'uidReviewer', decidedAt: new Date(), ...app,
  })
}

/** A new phone sign-up: a verified number, no e-mail at all. */
function phoneUser(uid = 'U1', phone = PHONE) {
  records.set(uid, { phoneNumber: phone, providerData: [{ providerId: 'phone' }] })
  db.seed(`users/${uid}`, { name: 'Invited Host', phoneNumber: phone })
}

describe('QA #51 — the original failure, as a regression', () => {
  beforeEach(() => world())

  test('a phone-only invited host FINDS the invitation (was: "Details don\'t match the agency record")', async () => {
    phoneUser()
    const r = await check('U1', phoneToken())
    expect(r.valid).toBe(true)
    expect(r.reason).toBe(undefined)
    expect(r.agencyName).toBe('QA Agency CRM')
    // …and is told which contact is still missing, as the agency registered it
    expect(r.needsVerification).toEqual(['email'])
    expect(r.contactHint.email).toBe('i•••@example.test')
    expect(JSON.stringify(r).includes('invited.host')).toBe(false)
  })

  test('redeeming CLAIMS the invitation for this account; the role does not start yet', async () => {
    phoneUser()
    const r = await redeem('U1', phoneToken())
    expect(r.awaitingVerification).toBe(true)
    expect(r.alreadyActivated).toBe(false)
    expect(r.missing).toEqual(['email'])
    expect(r.contactHint.email).toBe('i•••@example.test')
    const inv = db.read('hostApplications/INV1')
    expect(inv.applicantUid).toBe('U1')
    expect(inv.status).toBe('awaiting_verification')
    expect(inv.claimedVia).toBe('invitation_code')
    expect(inv.activationPending).toEqual(['email'])
    // the server's approval and the agreed terms are untouched
    expect(inv.kycStatus).toBe('approved')
    expect(inv.decidedByUid).toBe('uidReviewer')
    expect(inv.isActivated).toBe(false)
    // not a Host: no flag, no roster row, no verification record
    expect(db.read('users/U1').isHost).toBe(undefined)
    expect(db.read('agencies/AG1/agencyHosts/U1')).toBe(undefined)
    expect(db.read('hostVerification/U1')).toBe(undefined)
  })

  test('entering the code again only reports the waiting state — nothing is granted twice', async () => {
    phoneUser()
    await redeem('U1', phoneToken())
    const again = await redeem('U1', phoneToken())
    expect(again.awaitingVerification).toBe(true)
    expect(db.read('users/U1').isHost).toBe(undefined)
    const pre = await check('U1', phoneToken())
    expect(pre.valid).toBe(true)
    expect(pre.needsVerification).toEqual(['email'])
  })

  test('a Google sign-up (verified e-mail, no phone) claims it the same way, missing the phone', async () => {
    records.set('G1', { email: EMAIL, emailVerified: true, providerData: [{ providerId: 'google.com', email: EMAIL }] })
    db.seed('users/G1', { name: 'g' })
    const r = await redeem('G1', googleToken())
    expect(r.awaitingVerification).toBe(true)
    expect(r.missing).toEqual(['phone'])
    expect(r.contactHint.phone).toBe('••••0004')
    expect(db.read('hostApplications/INV1').applicantUid).toBe('G1')
  })

  test('with BOTH contacts verified and matching, the redemption is unchanged: the Host role starts', async () => {
    records.set('U9', { phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] })
    db.seed('users/U9', { name: 'Both' })
    const r = await redeem('U9', bothToken)
    expect(r.awaitingVerification).toBe(undefined)
    expect(r.alreadyActivated).toBe(false)
    expect(db.read('users/U9').isHost).toBe(true)
    expect(db.read('users/U9').agencyId).toBe('AG1')
    expect(db.read('hostApplications/INV1').activatedByUid).toBe('U9')
    expect(db.read('hostVerification/U9').agencyPhotoUrl).toBe('https://x/agency-photo.jpg')
  })
})

describe('QA #51 — an invitation cannot be claimed by an unrelated person', () => {
  beforeEach(() => world())

  test('a different verified phone is refused and writes nothing', async () => {
    phoneUser('X1', '+919990019999')
    const r = await check('X1', phoneToken('+919990019999'))
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('account_mismatch')
    const e = await refusal(redeem('X1', phoneToken('+919990019999')))
    expect(e.code).toBe('permission-denied')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
    expect(db.read('hostApplications/INV1').status).toBe('approved')
  })

  test('the invited phone but a CONTRADICTING verified e-mail is refused', async () => {
    records.set('X2', { phoneNumber: PHONE, email: 'someone.else@example.test', emailVerified: true, providerData: [] })
    db.seed('users/X2', { name: 'x' })
    const tok = { phone_number: PHONE, email: 'someone.else@example.test', email_verified: true, firebase: { sign_in_provider: 'phone' } }
    expect((await check('X2', tok)).reason).toBe('account_mismatch')
    const e = await refusal(redeem('X2', tok))
    expect(e.code).toBe('permission-denied')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })

  test('typed contacts in the request count for nothing', async () => {
    // An account with a different verified phone types the invited phone and e-mail.
    phoneUser('X3', '+919990012345')
    const r = await check('X3', phoneToken('+919990012345'), { phone: PHONE, email: EMAIL })
    expect(r.valid).toBe(false)
    const e = await refusal(redeem('X3', phoneToken('+919990012345'), { phone: PHONE, email: EMAIL }))
    expect(e.code).toBe('permission-denied')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })

  test('once claimed, another account cannot use it — even with the invited e-mail verified', async () => {
    phoneUser()
    await redeem('U1', phoneToken())
    records.set('X4', { email: EMAIL, emailVerified: true, providerData: [{ providerId: 'google.com', email: EMAIL }] })
    db.seed('users/X4', { name: 'x' })
    const r = await check('X4', googleToken())
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('already_used')
    const e = await refusal(redeem('X4', googleToken()))
    expect(e.code).toBe('failed-precondition')
    expect(e.message).toContain('already been used')
    expect(db.read('hostApplications/INV1').applicantUid).toBe('U1')
  })

  test('a bare national number on an old invitation does not let a phone ALONE claim it', async () => {
    world({ app: { applicantPhone: '9990010004' } })
    phoneUser()
    const r = await check('U1', phoneToken())
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('account_mismatch')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
    // …the e-mail can: an e-mail-verified account claims it, and the phone is compared later
    records.set('G2', { email: EMAIL, emailVerified: true, providerData: [{ providerId: 'google.com', email: EMAIL }] })
    db.seed('users/G2', { name: 'g' })
    expect((await check('G2', googleToken())).valid).toBe(true)
  })

  test('a guest cannot claim; a banned account cannot claim', async () => {
    phoneUser()
    const guest = await check('U1', { firebase: { sign_in_provider: 'anonymous' } })
    expect(guest.reason).toBe('guest')
    db.seed('users/U1', { name: 'b', isBanned: true, accountState: 'banned' })
    expect((await check('U1', phoneToken())).reason).toBe('restricted')
    const e = await refusal(redeem('U1', phoneToken()))
    expect(e.code).toBe('permission-denied')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })
})

describe('QA #51 — expired, revoked, already-used and unapproved invitations', () => {
  test('not yet approved by staff: refused, nothing claimed', async () => {
    world({ app: { status: 'pending', decidedByUid: '', decidedAt: null } })
    phoneUser()
    expect((await check('U1', phoneToken())).reason).toBe('not_approved')
    const e = await refusal(redeem('U1', phoneToken()))
    expect(e.code).toBe('failed-precondition')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })

  test('refused by staff (revoked invitation): "rejected"', async () => {
    world({ app: { status: 'rejected', kycStatus: 'rejected' } })
    phoneUser()
    expect((await check('U1', phoneToken())).reason).toBe('rejected')
    expect(await refusal(redeem('U1', phoneToken()))).not.toBe(null)
  })

  test('withdrawn by the agency (deleted): the code is "not found"', async () => {
    world()
    db._docs.delete('hostApplications/INV1')
    phoneUser()
    expect((await check('U1', phoneToken())).reason).toBe('not_found')
    expect((await refusal(redeem('U1', phoneToken()))).code).toBe('not-found')
  })

  test('already redeemed by someone else: "already used"', async () => {
    world({ app: { isActivated: true, activatedByUid: 'SOMEONE' } })
    records.set('U9', { phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] })
    db.seed('users/U9', { name: 'u' })
    expect((await check('U9', bothToken)).reason).toBe('already_used')
    const e = await refusal(redeem('U9', bothToken))
    expect(e.message).toContain('already been used')
  })

  test('expired in practice — the agency stopped taking hosts: "agency_inactive", with the sentence', async () => {
    world({ agency: { status: 'suspended' } })
    phoneUser()
    const r = await check('U1', phoneToken())
    expect(r.valid).toBe(false)
    expect(r.reason).toBe('agency_inactive')
    expect(r.message).toBe('This agency is not currently accepting hosts.')
    expect(await refusal(redeem('U1', phoneToken()))).not.toBe(null)
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })

  test('expired in practice — the agency changed its code: the old code is "not found"', async () => {
    world({ agency: { referralCode: 'NEWCODE1' } })
    phoneUser()
    expect((await check('U1', phoneToken())).reason).toBe('not_found')
    expect(await refusal(redeem('U1', phoneToken()))).not.toBe(null)
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
  })
})

/*
 * Security review of the QA fixes (3 Nov 2026). The phone lookup QA #51 added
 * reads up to PHONE_SCAN_LIMIT invitations a call, and the answer tells a code
 * nobody has from one issued to somebody else; the claim it added left no
 * record of its own. Pinned here:
 *
 *   * `checkReferralCode` and `activateHost` share one budget per ACCOUNT
 *     (`hostInvitationLookup`): 30 in ten minutes, then `resource-exhausted`
 *     (`RATE_LIMITED`) before any invitation is read or claimed; another
 *     account is unaffected; the bucket stores no uid;
 *   * a claim records HOST_INVITATION_CLAIMED once, with ids only;
 *   * the phone scan's "hit its limit" warning names the agency, not the code.
 */
describe('security review — the invitation lookup is bounded and the claim is recorded', () => {
  beforeEach(() => world())
  const RL = require('../lib/rateLimit')
  const functions = require('firebase-functions')

  test('30 lookups per account in ten minutes, shared by check and redeem; then refused before anything is read', async () => {
    phoneUser()
    for (let i = 0; i < 15; i++) {
      expect((await check('U1', phoneToken())).valid).toBe(true)
    }
    for (let i = 0; i < 15; i++) {
      // the first claims, the rest report the waiting state
      expect((await redeem('U1', phoneToken())).awaitingVerification).toBe(true)
    }
    const c = await refusal(check('U1', phoneToken()))
    expect(c && c.code).toBe('resource-exhausted')
    expect(c.details.code).toBe(RL.RATE_LIMITED)
    expect(c.details.retryAfterMs > 0).toBe(true)
    const r = await refusal(redeem('U1', phoneToken()))
    expect(r && r.code).toBe('resource-exhausted')

    // another account is not affected by this one's budget
    records.set('G1', { email: EMAIL, emailVerified: true, providerData: [{ providerId: 'google.com', email: EMAIL }] })
    db.seed('users/G1', { name: 'g' })
    expect((await check('G1', googleToken())).reason).toBe('already_used')

    // the buckets carry a hash, never the uid
    const buckets = db.all('rateLimits')
    expect(buckets.length > 0).toBe(true)
    for (const b of buckets) {
      expect(b.scope).toBe('hostInvitationLookup')
      expect(JSON.stringify(b).includes('U1')).toBe(false)
      expect(b.id.includes('U1')).toBe(false)
    }
  })

  test('a refused redemption claims nothing', async () => {
    phoneUser()
    for (let i = 0; i < 30; i++) await check('U1', phoneToken())
    const e = await refusal(redeem('U1', phoneToken()))
    expect(e && e.code).toBe('resource-exhausted')
    expect(db.read('hostApplications/INV1').applicantUid).toBe(undefined)
    expect(db.read('hostApplications/INV1').status).toBe('approved')
  })

  test('the per-address budget (300 in ten minutes) applies when the address is known', async () => {
    expect(RL.RATE_LIMIT_POLICIES.hostInvitationLookup).toEqual({
      perDevice: { limit: 30, windowMs: 600_000 },
      perIp: { limit: 300, windowMs: 600_000 },
    })
    phoneUser()
    const viaAddress = { auth: { uid: 'U1', token: phoneToken() }, rawRequest: { headers: { 'x-forwarded-for': '203.0.113.7' } } }
    await H.checkReferralCode.run({ referralCode: CODE }, viaAddress)
    const kinds = db.all('rateLimits').map((b) => b.kind).sort()
    expect(kinds).toEqual(['dev', 'ip'])
    expect(JSON.stringify(db.all('rateLimits')).includes('203.0.113.7')).toBe(false)
  })

  test('a claim records HOST_INVITATION_CLAIMED once — ids and what is missing, no code or contact', async () => {
    phoneUser()
    const first = await redeem('U1', phoneToken())
    expect(first.awaitingVerification).toBe(true)
    expect(Object.keys(first).includes('claimedNow')).toBe(false)   // the internal marker is not sent
    await redeem('U1', phoneToken())   // re-entry reports; it does not claim again
    const events = db.all('authEvents').filter((e) => e.event === 'HOST_INVITATION_CLAIMED')
    expect(events.length).toBe(1)
    expect(events[0].uid).toBe('U1')
    expect(events[0].applicationId).toBe('INV1')
    expect(events[0].agencyId).toBe('AG1')
    expect(events[0].missing).toEqual(['email'])
    const text = JSON.stringify(events[0])
    for (const secret of [CODE, '99900', 'invited.host', 'example.test']) expect(text.includes(secret)).toBe(false)
  })

  test('no claim, no event: a refused claim and a full redemption record none', async () => {
    phoneUser('X1', '+919990019999')
    await refusal(redeem('X1', phoneToken('+919990019999')))
    records.set('U9', { phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] })
    db.seed('users/U9', { name: 'Both' })
    await redeem('U9', bothToken)
    expect(db.all('authEvents').filter((e) => e.event === 'HOST_INVITATION_CLAIMED')).toEqual([])
  })

  test('the phone scan warning names the agency, never the code', async () => {
    for (let i = 0; i < H.PHONE_SCAN_LIMIT; i++) {
      db.seed(`hostApplications/OPEN${i}`, {
        referralCode: CODE, agencyId: 'AG1', applicantPhone: `+9188800${String(i).padStart(5, '0')}`,
        applicantEmail: `other${i}@example.test`, isActivated: false, status: 'approved',
      })
    }
    phoneUser()
    const warned = []
    const real = functions.logger.warn
    functions.logger.warn = (...args) => { warned.push(args) }
    try { await check('U1', phoneToken()) } finally { functions.logger.warn = real }
    const hit = warned.find((a) => String(a[0]).includes('phone scan hit its limit'))
    expect(Boolean(hit)).toBe(true)
    expect(hit[1]).toEqual({ agencyId: 'AG1', limit: H.PHONE_SCAN_LIMIT })
    expect(JSON.stringify(warned).includes(CODE)).toBe(false)
  })
})

describe('QA #51 — the pure match rule', () => {
  const inv = { applicantPhone: INVITED_PHONE_TYPED, applicantEmail: EMAIL }
  test('one proved contact that matches, none that contradicts → ok, with what is missing', () => {
    expect(H.invitationContactMatch(inv, { phone: PHONE })).toEqual({ ok: true, mismatch: false, full: false, missing: ['email'] })
    expect(H.invitationContactMatch(inv, { email: EMAIL })).toEqual({ ok: true, mismatch: false, full: false, missing: ['phone'] })
    expect(H.invitationContactMatch(inv, { phone: PHONE, email: EMAIL }).full).toBe(true)
  })
  test('a contradiction is a mismatch whatever else matches', () => {
    expect(H.invitationContactMatch(inv, { phone: PHONE, email: 'x@y.z' }).mismatch).toBe(true)
    expect(H.invitationContactMatch(inv, { phone: '+14155550100', email: EMAIL }).ok).toBe(false)
  })
  test('nothing proved → nothing claimed; an invitation missing a contact never matches', () => {
    expect(H.invitationContactMatch(inv, {}).ok).toBe(false)
    expect(H.invitationContactMatch({ applicantPhone: INVITED_PHONE_TYPED }, { phone: PHONE }).ok).toBe(false)
  })
  test('masks are the backend\'s shapes', () => {
    expect(H.maskInvitedEmail('Person@Example.com')).toBe('p•••@example.com')
    expect(H.maskInvitedPhone('+91 99900 10004')).toBe('••••0004')
  })
})

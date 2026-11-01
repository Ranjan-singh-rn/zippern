/**
 * FX phase — record integrity in the partner-registration trigger (FX-06) and
 * the machine-readable contact refusal through the application callables
 * (approved contact rule). Executed over the fake Firestore; `fetch` is a
 * recorder, so no request leaves this process.
 *
 *   FX-06  the trigger's outcome write never RE-CREATES a document that was
 *          deleted meanwhile (DUP-02: a deleted application came back as a
 *          stub, fired the trigger again and became an ownerless partner);
 *          `self_app` documents — already registered by the API that wrote
 *          them — are not registered a second time.
 *   CONTACT the API's `CONTACT_REQUIRED` refusal reaches the app as
 *          `failed-precondition` with `details.code`, `details.missing`,
 *          `details.requirement` and `details.emailUnverified`; an ordinary
 *          refusal stays a plain sentence with no details.
 *
 * ZIPPER_FUNCTIONS_LIB=<dir> loads another compiled `lib` (used once against
 * the pre-fix build to show these cases failing there).
 *
 * Run:  node --test test/fxRecordIntegrity.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const path = require('node:path')
const { expect } = require('./expect')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

const KEY = 'k'.repeat(40)
const BASE = 'https://api.zipper.test'

const sent = []
let reply = { status: 200, body: {} }
globalThis.fetch = async (url, init) => {
  sent.push({
    url: String(url),
    method: init && init.method,
    body: init && init.body ? JSON.parse(init.body) : undefined,
  })
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: async () => JSON.stringify(reply.body),
  }
}

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const index = require(path.join(LIB, 'index'))

beforeEach(() => {
  sent.length = 0
  reply = { status: 200, body: {} }
  process.env.ZIPPER_PARTNER_REGISTRATION_KEY = KEY
  process.env.ZIPPER_API_BASE_URL = BASE
})

async function created(collection, id, data) {
  const ref = db.collection(collection).doc(id)
  await ref.set(data)
  return ref.get()
}

async function settle(p) {
  try { return { value: await p } } catch (error) { return { error } }
}

describe('FX-06 — the registration trigger never resurrects a deleted application', () => {
  test('API refuses because the document is gone → the outcome write does not re-create it', async () => {
    const snap = await created('agencies', 'A-race-1', {
      agencyName: 'Raced', type: 'main', status: 'pending', kycStatus: 'pending',
      ownerUid: 'U-race', source: 'self_signup',
    })
    // The application was refused and deleted before the trigger's call landed.
    await db.collection('agencies').doc('A-race-1').delete()
    reply = { status: 400, body: { detail: "No agencies document with id 'A-race-1'." } }
    await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-race-1' } }))
    const after = await db.collection('agencies').doc('A-race-1').get()
    expect(after.exists).toBe(false)
  })

  test('the same holds for a seller document', async () => {
    const snap = await created('sellers', 'S-race-1', {
      displayName: 'Raced seller', status: 'pending', isApproved: false, isActive: false,
      ownerUid: 'U-race-s', source: 'self_signup',
    })
    await db.collection('sellers').doc('S-race-1').delete()
    reply = { status: 400, body: { detail: "No sellers document with id 'S-race-1'." } }
    await settle(index.registerSellerPartner.run(snap, { params: { sellerId: 'S-race-1' } }))
    const after = await db.collection('sellers').doc('S-race-1').get()
    expect(after.exists).toBe(false)
  })

  test('a document that still exists DOES get its outcome recorded (no regression)', async () => {
    const snap = await created('agencies', 'A-ok-1', {
      agencyName: 'Fine', type: 'main', status: 'pending', kycStatus: 'pending',
      ownerUid: 'U-ok', source: 'self_signup',
    })
    reply = { status: 201, body: { id: 'A-ok-1', kind: 'agency', status: 'pending', created: true, warnings: [] } }
    await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-ok-1' } }))
    const after = (await db.collection('agencies').doc('A-ok-1').get()).data()
    expect(after.partnerRecord.status).toBe('registered')
    expect(after.partnerRecordFailed).toBe(false)
    expect(sent.length).toBe(1)
  })

  test('a refusal on a document that still exists is recorded as failed (no regression)', async () => {
    const snap = await created('agencies', 'A-refused-1', {
      agencyName: 'Refused', type: 'main', status: 'pending', kycStatus: 'pending',
      ownerUid: 'U-refused', source: 'self_signup',
    })
    reply = { status: 400, body: { detail: 'You already hold a Agency.' } }
    const r = await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-refused-1' } }))
    expect(Boolean(r.error)).toBe(true)
    const after = (await db.collection('agencies').doc('A-refused-1').get()).data()
    expect(after.partnerRecordFailed).toBe(true)
  })

  test("a `self_app` document is not registered again — the API that wrote it already did", async () => {
    const snap = await created('agencies', 'A-selfapp-1', {
      agencyName: 'From the app', type: 'main', status: 'pending', kycStatus: 'submitted',
      ownerUid: 'U-app', crmUid: 'U-app', source: 'self_app',
    })
    const r = await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-selfapp-1' } }))
    expect(Boolean(r.error)).toBe(false)
    expect(sent.length).toBe(0)
    const after = (await db.collection('agencies').doc('A-selfapp-1').get()).data()
    expect(after.partnerRecord).toBe(undefined)
  })

  test("…nor a `self_app` seller", async () => {
    const snap = await created('sellers', 'S-selfapp-1', {
      displayName: 'From the app', status: 'pending', isApproved: false, isActive: false,
      ownerUid: 'U-app-s', crmUid: 'U-app-s', source: 'self_app',
    })
    await settle(index.registerSellerPartner.run(snap, { params: { sellerId: 'S-selfapp-1' } }))
    expect(sent.length).toBe(0)
  })

  test('trigger redelivery on an existing document is idempotent (created:false is success)', async () => {
    const snap = await created('agencies', 'A-redeliver-1', {
      agencyName: 'Twice', type: 'main', status: 'pending', kycStatus: 'pending',
      ownerUid: 'U-twice', source: 'self_signup',
    })
    reply = { status: 201, body: { id: 'A-redeliver-1', kind: 'agency', status: 'pending', created: true } }
    await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-redeliver-1' } }))
    reply = { status: 201, body: { id: 'A-redeliver-1', kind: 'agency', status: 'pending', created: false } }
    const r = await settle(index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-redeliver-1' } }))
    expect(Boolean(r.error)).toBe(false)
    const after = (await db.collection('agencies').doc('A-redeliver-1').get()).data()
    expect(after.partnerRecord.status).toBe('registered')
    expect(after.partnerRecord.created).toBe(false)
  })
})

describe('CONTACT — the machine-readable refusal reaches the app', () => {
  const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000 } } })
  const CONTACT = {
    message: 'Guest accounts cannot apply for partner or host roles. Add and verify your phone number or email first.',
    code: 'CONTACT_REQUIRED',
    requirement: 'one_of',
    missing: ['phone', 'email'],
    emailUnverified: true,
  }

  beforeEach(async () => {
    await db.collection('users').doc('U-contact').set({ name: 'U' })
  })

  test('submitPartnerApplication: failed-precondition with details.code CONTACT_REQUIRED', async () => {
    reply = { status: 400, body: { detail: CONTACT } }
    const r = await settle(index.submitPartnerApplication.run({ kind: 'agency', form: {} }, ctx('U-contact')))
    expect(Boolean(r.error)).toBe(true)
    expect(r.error.code).toBe('failed-precondition')
    expect(r.error.message).toBe(CONTACT.message)
    expect(r.error.details && r.error.details.code).toBe('CONTACT_REQUIRED')
    expect(JSON.stringify(r.error.details.missing)).toBe(JSON.stringify(['phone', 'email']))
    expect(r.error.details.requirement).toBe('one_of')
    expect(r.error.details.emailUnverified).toBe(true)
  })

  test('submitHostApplication: the same', async () => {
    reply = { status: 400, body: { detail: CONTACT } }
    const r = await settle(index.submitHostApplication.run({ parentId: 'MAIN1', form: {} }, ctx('U-contact')))
    expect(r.error && r.error.code).toBe('failed-precondition')
    expect(r.error.details && r.error.details.code).toBe('CONTACT_REQUIRED')
  })

  test('an ordinary refusal stays a plain sentence with no code', async () => {
    reply = { status: 400, body: { detail: 'You already hold a Agency.' } }
    const r = await settle(index.submitPartnerApplication.run({ kind: 'agency', form: {} }, ctx('U-contact')))
    expect(r.error && r.error.code).toBe('failed-precondition')
    expect(r.error.message).toBe('You already hold a Agency.')
    expect(r.error.details && r.error.details.code).toBe(undefined)
  })

  test('the uid sent to the API is the token\'s, never the request body\'s (direct call)', async () => {
    reply = { status: 400, body: { detail: CONTACT } }
    await settle(index.submitPartnerApplication.run(
      { kind: 'agency', form: {}, applicant_uid: 'SOMEONE-ELSE', uid: 'SOMEONE-ELSE' }, ctx('U-contact')))
    expect(sent.length).toBe(1)
    expect(sent[0].body.applicant_uid).toBe('U-contact')
  })
})

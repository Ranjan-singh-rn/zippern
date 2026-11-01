/**
 * Decision 16 (RC) — a fresh Sub-agency application after a rejection is
 * written AND registered by the API itself (`reapply_sub_agency`,
 * `source: 'reapply'`). The registration trigger must not register it a
 * second time (that only races the API's own delete of a refused document —
 * the DUP-02 shape). Executed over the fake Firestore; `fetch` is a recorder.
 *
 * Run:  node --test test/rcReapplyTrigger.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const path = require('node:path')
const { expect } = require('./expect')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

const sent = []
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), method: init && init.method })
  return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'x', created: true, warnings: [] }) }
}

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const index = require(path.join(LIB, 'index'))

beforeEach(() => {
  sent.length = 0
  process.env.ZIPPER_PARTNER_REGISTRATION_KEY = 'k'.repeat(40)
  process.env.ZIPPER_API_BASE_URL = 'https://api.zipper.test'
})

async function created(id, data) {
  const ref = db.collection('agencies').doc(id)
  await ref.set(data)
  return ref.get()
}

describe('the registration trigger and a re-application', () => {
  test('a `reapply` document is not registered again — the API that wrote it already did', async () => {
    const snap = await created('A-reapply-1', {
      agencyName: 'Second try', type: 'sub', parentAgencyId: 'MAIN1', status: 'pending',
      kycStatus: 'submitted', ownerUid: 'U-sub', crmUid: 'U-sub', source: 'reapply',
      reapplicationOf: 'A-rejected-1',
    })
    await index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-reapply-1' } })
    expect(sent.length).toBe(0)
    expect((await db.collection('agencies').doc('A-reapply-1').get()).data().partnerRecord).toBe(undefined)
  })

  test('a parent-created sub-agency (agency_created) is still registered (no regression)', async () => {
    const snap = await created('A-sub-new', {
      agencyName: 'First try', type: 'sub', parentAgencyId: 'MAIN1', status: 'pending',
      kycStatus: 'submitted', crmUid: 'U-sub2', source: 'agency_created', createdByUid: 'U-parent',
    })
    await index.registerAgencyPartner.run(snap, { params: { agencyId: 'A-sub-new' } })
    expect(sent.length).toBe(1)
  })
})

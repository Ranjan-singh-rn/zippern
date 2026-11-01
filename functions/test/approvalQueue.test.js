/**
 * GOV-1 (Phase 1A.2, B5) — `onApprovalApproved`, the approval queue's applier.
 *
 * An approved `approvalRequests` document is applied by this trigger through
 * the Admin SDK, past every rule. Before B5 the browser that FILED a request
 * chose the operation, the collection, the document id and the payload, so one
 * approval could overwrite or delete any document — an Owner's `crmUsers`
 * record included — and an Owner could approve their own request.
 *
 *   * REFUSED — each case below was applied before B5. Refused now, the target
 *     is left untouched and the request is marked rejected with the reason.
 *   * STILL APPLIED — the four shapes the current CRM files:
 *       update_config → appConfig/economy   (economy config, finance_admin)
 *       update_config → appConfig/control   (app control, tech_admin / tech_member)
 *       create_agency → a new agencies doc  (agencies/register, app_admin)
 *       create_seller → a new sellers doc   (sellers/register, app/ops)
 *     approved by an Owner who did not file them.
 *
 * ZIPPER_FUNCTIONS_LIB=<dir> loads the trigger from another compiled `lib` —
 * used once, against the pre-B5 build, to show the REFUSED cases failing
 * there. Unset, the suite tests ../lib.
 *
 * Run:  node --test test/approvalQueue.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore } = require('./fakeFirestore')
const db = installFakeFirestore()

// ── Adaptation: real field deletes (failApproval deletes `appliedAt`) ───────
const isDeleteSentinel = (v) =>
  v != null && typeof v === 'object' && v.constructor && v.constructor.name === 'DeleteTransform'
const DocRef = db.collection('_probe').doc('_probe').constructor
for (const method of ['set', 'update']) {
  const original = DocRef.prototype[method]
  DocRef.prototype[method] = async function patched(data, opts) {
    const drop = Object.keys(data || {}).filter((k) => isDeleteSentinel(data[k]))
    const rest = { ...data }
    for (const k of drop) delete rest[k]
    await original.call(this, rest, opts)
    const stored = this._store._docs.get(this.path)
    if (stored) for (const k of drop) delete stored[k]
  }
}
// The pre-B5 `custom` branch commits a batch; without one the red run would
// fail for the wrong reason.
db.batch = () => {
  const ops = []
  return {
    set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)) },
    update: (ref, data) => { ops.push(() => ref.update(data)) },
    delete: (ref) => { ops.push(() => ref.delete()) },
    commit: async () => { for (const op of ops) await op() },
  }
}
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [] }),
    createCustomToken: async (uid) => `t-${uid}`,
    revokeRefreshTokens: async () => undefined,
    setCustomUserClaims: async () => undefined,
  }),
})

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const { onApprovalApproved } = require(path.join(LIB, 'index'))

// ── The cast ────────────────────────────────────────────────────────────────
const OWNER_A = 'uidOwnerA'
const OWNER_B = 'uidOwnerB'
const FINANCE = 'uidFinanceAdmin'
const TECH = 'uidTechMember'
const APP_ADMIN = 'uidAppAdmin'
const OPS = 'uidOpsAdmin'

function seedCast() {
  db.seed(`crmUsers/${OWNER_A}`, { uid: OWNER_A, role: 'superadmin', isActive: true, status: 'approved' })
  db.seed(`crmUsers/${OWNER_B}`, { uid: OWNER_B, role: 'superadmin', isActive: true, status: 'approved' })
  db.seed(`crmUsers/${FINANCE}`, { uid: FINANCE, role: 'finance_admin', isActive: true })
  db.seed(`crmUsers/${TECH}`, { uid: TECH, role: 'tech_member', isActive: true })
  db.seed(`crmUsers/${APP_ADMIN}`, { uid: APP_ADMIN, role: 'app_admin', isActive: true })
  db.seed(`crmUsers/${OPS}`, { uid: OPS, role: 'ops_admin', isActive: true })
  db.seed('appConfig/economy', { beansPerRupee: 100, diamondPrice: 1 })
  db.seed('appConfig/control', { maintenanceMode: false, featureFlags: [] })
  db.seed('users/uidVictim', { uid: 'uidVictim', diamonds: 10, beans: 0 })
  db.seed('hostApplications/HA_1', { agencyId: 'AG_1', status: 'pending', kycStatus: 'submitted' })
  db.seed('agencies/AG_1', {
    agencyName: 'Existing Agency', status: 'pending', isActive: false, ownerEmail: 'a1@example.test',
    crmUid: 'uidAgencyLogin', accountNumber: '000011112222',
  })
  // The agency's own login, so the pre-B5 `approve_agency` branch succeeds in
  // full (it updates this too) — the fake's batch is not atomic, and a
  // half-applied batch would make the red run fail for the wrong reason.
  db.seed('crmUsers/uidAgencyLogin', { uid: 'uidAgencyLogin', role: 'agency', agencyId: 'AG_1', status: 'pending', isActive: true })
}

let seq = 0
/**
 * File a request as `requester`, then approve it as `reviewer` — the
 * before/after pair the trigger receives when an Owner presses Approve.
 */
async function approve(request, { requester = APP_ADMIN, reviewer = OWNER_A, reviewedBy } = {}) {
  const id = `REQ_${++seq}`
  const filed = {
    description: 'test', targetLabel: 'test', targetDocId: '', payload: {},
    requestedBy: { uid: requester, name: requester, role: 'x' },
    requestedAt: new Date(), status: 'pending', ...request,
  }
  const decided = {
    ...filed, status: 'approved', reviewedAt: new Date(), reviewNotes: '',
    ...(reviewedBy === undefined ? { reviewedBy: { uid: reviewer, name: reviewer } } : reviewedBy),
  }
  db.seed(`approvalRequests/${id}`, decided)
  const ref = db.collection('approvalRequests').doc(id)
  await onApprovalApproved.run(
    { before: { data: () => filed }, after: { data: () => decided, ref } },
    { params: { requestId: id } },
  )
  return db.read(`approvalRequests/${id}`)
}

const refused = (req) => {
  expect(req.status).toBe('rejected')
  expect(req.applyFailed).toBe(true)
  expect(req.appliedAt).toBeUndefined()
}

// The register pages' payloads, field for field (agencies/register,
// sellers/register), plus the login they created before filing.
const AGENCY_PAYLOAD = {
  crmId: 'A1B2C3D4', agencyName: 'Queue Agency', ownerName: 'Q Owner', ownerPhone: '+919800000501',
  ownerEmail: 'queue-agency@example.test', address: 'Pune', type: 'main', parentAgencyId: null,
  referralCode: 'QUEU1234', status: 'pending', kycStatus: 'pending', kycDocUrls: ['a', 'b', 'c'],
  paymentType: 'bank', currency: 'INR', isActive: false, source: 'crm', totalHosts: 0,
  totalSubAgencies: 0, accountHolderName: 'Q Owner', accountNumber: '123456789012',
  ifscCode: 'ZIPR0000050', bankName: 'Zip Bank', branch: 'Main', upiId: 'q@upi',
  crmUid: 'uidNewAgencyLogin',
}
const SELLER_PAYLOAD = {
  crmId: 'S1S2S3S4', displayName: 'Queue Coins', phone: '+919800000502',
  email: 'queue-seller@example.test', city: 'Pune', description: 'Open 9 to 6',
  idDocUrls: [{ label: 'Aadhaar', url: 'u' }], isApproved: false, isActive: false,
  status: 'pending', coinBalance: 0, totalCoinsSold: 0, qrCodeUrl: '', source: 'crm_admin',
  crmUid: 'uidNewSellerLogin',
}

describe('GOV-1 — refused: requests the current CRM never files', () => {
  beforeEach(() => { db._docs.clear(); seedCast() })

  test('a create aimed at crmUsers cannot mint or overwrite an Owner', async () => {
    const before = db.read(`crmUsers/${OWNER_B}`)
    const req = await approve({
      type: 'create_agency', operation: 'create', targetCollection: 'crmUsers', targetDocId: OWNER_B,
      payload: { uid: OWNER_B, role: 'superadmin', isActive: true, email: 'attacker@example.test' },
    })
    refused(req)
    expect(db.read(`crmUsers/${OWNER_B}`)).toEqual(before)
  })

  test('a create aimed at users/{uid} cannot rewrite a balance', async () => {
    const req = await approve({
      type: 'create_seller', operation: 'create', targetCollection: 'users', targetDocId: 'uidVictim',
      payload: { uid: 'uidVictim', diamonds: 999999999 },
    })
    refused(req)
    expect(db.read('users/uidVictim').diamonds).toBe(10)
  })

  test('a create aimed at hostApplications cannot approve a host', async () => {
    const req = await approve({
      type: 'create_agency', operation: 'create', targetCollection: 'hostApplications', targetDocId: 'HA_1',
      payload: { agencyId: 'AG_1', status: 'approved', kycStatus: 'approved' },
    })
    refused(req)
    expect(db.read('hostApplications/HA_1').status).toBe('pending')
  })

  test('a request typed update_config but filed as a create cannot replace the economy config', async () => {
    const req = await approve({
      type: 'update_config', operation: 'create', targetCollection: 'appConfig', targetDocId: 'economy',
      payload: { beansPerRupee: 1 },
    }, { requester: FINANCE })
    refused(req)
    expect(db.read('appConfig/economy')).toEqual({ beansPerRupee: 100, diamondPrice: 1 })
  })

  test('create_agency naming an existing agency id cannot overwrite it', async () => {
    const before = db.read('agencies/AG_1')
    const req = await approve({
      type: 'create_agency', operation: 'create', targetCollection: 'agencies', targetDocId: 'AG_1',
      payload: { ...AGENCY_PAYLOAD, accountNumber: '999999999999' },
    })
    refused(req)
    expect(db.read('agencies/AG_1')).toEqual(before)
  })

  for (const [label, type, collection, over] of [
    ['an already-approved, active agency', 'create_agency', 'agencies', { status: 'approved', isActive: true }],
    ['a seller opening with coin inventory', 'create_seller', 'sellers', { coinBalance: 1000000 }],
    ['an already-approved seller', 'create_seller', 'sellers', { isApproved: true, isActive: true }],
    ['a seller hung on another human (ownerUid)', 'create_seller', 'sellers', { ownerUid: 'uidVictim' }],
  ]) {
    test(`a registration cannot create ${label}`, async () => {
      const payload = { ...(type === 'create_agency' ? AGENCY_PAYLOAD : SELLER_PAYLOAD), ...over }
      const req = await approve({ type, operation: 'create', targetCollection: collection, payload })
      refused(req)
      expect(db.count(collection)).toBe(collection === 'agencies' ? 1 : 0)
      expect(db.has(`crmUsers/${payload.crmUid}`)).toBe(false)
    })
  }

  test('a delete removes nothing — here, an Owner\'s crmUsers record', async () => {
    const req = await approve({
      type: 'deactivate_crm_user', operation: 'delete', targetCollection: 'crmUsers', targetDocId: OWNER_B,
    })
    refused(req)
    expect(db.has(`crmUsers/${OWNER_B}`)).toBe(true)
  })

  test('a delete of any other document is refused too', async () => {
    const req = await approve({
      type: 'remove_host', operation: 'delete', targetCollection: 'users', targetDocId: 'uidVictim',
    })
    refused(req)
    expect(db.has('users/uidVictim')).toBe(true)
  })

  test('custom approve_agency no longer approves a partner from the queue', async () => {
    const req = await approve({
      type: 'approve_agency', operation: 'custom', targetCollection: 'agencies', targetDocId: 'AG_1',
      payload: { approvedBy: OWNER_A, crmUid: 'uidAgencyLogin' },
    })
    refused(req)
    expect(db.read('agencies/AG_1').status).toBe('pending')
    expect(db.read('agencies/AG_1').isActive).toBe(false)
    expect(db.read('crmUsers/uidAgencyLogin').status).toBe('pending')
  })

  test('custom deactivate_agency cannot switch off an Owner\'s crmUsers record', async () => {
    const req = await approve({
      type: 'deactivate_agency', operation: 'custom', targetCollection: 'crmUsers', targetDocId: OWNER_B,
    })
    refused(req)
    expect(db.read(`crmUsers/${OWNER_B}`).isActive).toBe(true)
  })

  test('an Owner cannot approve a request they filed themselves', async () => {
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'economy',
      payload: { beansPerRupee: 5 },
    }, { requester: OWNER_A, reviewer: OWNER_A })
    refused(req)
    expect(req.applyError).toContain('same person')
    expect(db.read('appConfig/economy').beansPerRupee).toBe(100)
  })

  test('an approval naming a non-Owner as reviewer is not applied', async () => {
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'control',
      payload: { maintenanceMode: true },
    }, { requester: TECH, reviewer: OPS })
    refused(req)
    expect(db.read('appConfig/control').maintenanceMode).toBe(false)
  })

  test('an approval naming no reviewer at all is not applied', async () => {
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'control',
      payload: { maintenanceMode: true },
    }, { requester: TECH, reviewedBy: {} })
    refused(req)
    expect(db.read('appConfig/control').maintenanceMode).toBe(false)
  })

  test('a deactivated Owner\'s approval is not applied', async () => {
    db.seed(`crmUsers/${OWNER_B}`, { uid: OWNER_B, role: 'superadmin', isActive: false })
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'control',
      payload: { maintenanceMode: true },
    }, { requester: TECH, reviewer: OWNER_B })
    refused(req)
    expect(db.read('appConfig/control').maintenanceMode).toBe(false)
  })
})

describe('GOV-1 — unchanged refusals (controls)', () => {
  beforeEach(() => { db._docs.clear(); seedCast() })

  test('update_config cannot reach appConfig/paymentCredentials', async () => {
    db.seed('appConfig/paymentCredentials', { upiId: 'company@upi' })
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig',
      targetDocId: 'paymentCredentials', payload: { upiId: 'mallory@upi' },
    }, { requester: FINANCE })
    refused(req)
    expect(db.read('appConfig/paymentCredentials').upiId).toBe('company@upi')
  })

  test('a money type is still refused', async () => {
    const req = await approve({
      type: 'credit_diamonds', operation: 'custom', targetCollection: 'users', targetDocId: 'uidVictim',
      payload: { amount: 1000 },
    })
    refused(req)
    expect(db.read('users/uidVictim').diamonds).toBe(10)
  })

  test('add_host is still refused', async () => {
    const req = await approve({
      type: 'add_host', operation: 'update', targetCollection: 'hostApplications', targetDocId: 'HA_1',
      payload: { status: 'approved' },
    })
    refused(req)
    expect(db.read('hostApplications/HA_1').status).toBe('pending')
  })
})

describe('GOV-1 — still applied: what the CRM files, approved by another Owner', () => {
  beforeEach(() => { db._docs.clear(); seedCast() })

  test('update_config → appConfig/economy (finance_admin files, Owner approves)', async () => {
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'economy',
      payload: { beansPerRupee: 120 },
    }, { requester: FINANCE, reviewer: OWNER_A })
    expect(req.status).toBe('approved')
    expect(req.appliedAt).toBeTruthy()
    expect(req.applyFailed).toBeUndefined()
    expect(db.read('appConfig/economy').beansPerRupee).toBe(120)
    expect(db.read('appConfig/economy').diamondPrice).toBe(1)
  })

  test('update_config → appConfig/control (tech_member files, a second Owner approves)', async () => {
    const req = await approve({
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'control',
      payload: { maintenanceMode: true, featureFlags: [{ key: 'live', enabled: true }] },
    }, { requester: TECH, reviewer: OWNER_B })
    expect(req.status).toBe('approved')
    expect(req.appliedAt).toBeTruthy()
    expect(db.read('appConfig/control').maintenanceMode).toBe(true)
  })

  test('create_agency → a new agency and its pending CRM login', async () => {
    const req = await approve({
      type: 'create_agency', operation: 'create', targetCollection: 'agencies', payload: AGENCY_PAYLOAD,
    }, { requester: APP_ADMIN, reviewer: OWNER_A })
    expect(req.status).toBe('approved')
    expect(req.appliedAt).toBeTruthy()
    const created = db.all('agencies').filter((d) => d.agencyName === 'Queue Agency')
    expect(created).toHaveLength(1)
    expect(created[0].status).toBe('pending')
    expect(created[0].crmUid).toBe('uidNewAgencyLogin')
    const login = db.read('crmUsers/uidNewAgencyLogin')
    expect(login.role).toBe('agency')
    expect(login.status).toBe('pending')
  })

  test('create_seller → a new seller at zero and its pending CRM login', async () => {
    const req = await approve({
      type: 'create_seller', operation: 'create', targetCollection: 'sellers', payload: SELLER_PAYLOAD,
    }, { requester: OPS, reviewer: OWNER_A })
    expect(req.status).toBe('approved')
    expect(req.appliedAt).toBeTruthy()
    expect(db.count('sellers')).toBe(1)
    const seller = db.all('sellers')[0]
    expect(seller.coinBalance).toBe(0)
    expect(seller.isApproved).toBe(false)
    expect(seller.crmUid).toBe('uidNewSellerLogin')
    expect(db.read('crmUsers/uidNewSellerLogin').role).toBe('seller')
  })

  test('a rejection applies nothing', async () => {
    const id = `REQ_${++seq}`
    const filed = {
      type: 'update_config', operation: 'update', targetCollection: 'appConfig', targetDocId: 'economy',
      payload: { beansPerRupee: 1 }, requestedBy: { uid: FINANCE }, status: 'pending',
    }
    const decided = { ...filed, status: 'rejected', reviewedBy: { uid: OWNER_A }, reviewNotes: 'no' }
    db.seed(`approvalRequests/${id}`, decided)
    await onApprovalApproved.run(
      { before: { data: () => filed }, after: { data: () => decided, ref: db.collection('approvalRequests').doc(id) } },
      { params: { requestId: id } },
    )
    expect(db.read('appConfig/economy').beansPerRupee).toBe(100)
    expect(db.read(`approvalRequests/${id}`).appliedAt).toBeUndefined()
  })
})

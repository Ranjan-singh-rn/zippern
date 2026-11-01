/**
 * RC (confirmed) — "Invitation withdrawal deletes the invitation's KYC uploads."
 *
 * The shipped `onHostInvitationWithdrawn` trigger (lib/, as deployed) over the
 * fake Firestore, with a recording Storage bucket. This is a FUNCTIONS-LEVEL
 * test with mocked Firestore and Storage — not an end-to-end test: whether
 * the deployed trigger fires on a real delete, and whether the CRM's upload
 * bucket is the Functions default bucket, are deployment checks.
 *
 * Run:  node --test test/rcInvitationCleanup.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const BUCKET = 'zipper-test.appspot.com'
const storage = { deleted: [], failOn: new Set() }
Object.defineProperty(admin, 'storage', {
  configurable: true, writable: true,
  value: () => ({
    bucket: () => ({
      name: BUCKET,
      file: (p) => ({
        delete: async (opts) => {
          if (storage.failOn.has(p)) throw new Error('storage unavailable')
          if (!opts || opts.ignoreNotFound !== true) throw new Error('delete must ignore not-found (idempotent)')
          storage.deleted.push(p)
        },
      }),
    }),
  }),
})

const C = require('../lib/invitationCleanup')

const url = (p, bucket = BUCKET) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(p)}?alt=media&token=tok`
const INVITE = (over = {}) => ({
  agencyId: 'AG1', hostName: 'Invited', status: 'pending', isActivated: false, kycStatus: 'submitted',
  photoUrl: url('hostPhotos/AG1/1700_photo'),
  kycDocUrls: [
    url('kyc/AG1/applications/1700_doc1'),
    url('kyc/AG1/applications/1700_doc2'),
    url('kyc/AG1/applications/1700_doc3'),
  ],
  ...over,
})
const run = (data, id = 'HA1') => C.onHostInvitationWithdrawn.run(
  { id, exists: true, data: () => data }, { params: { appId: id } },
)

beforeEach(() => { db._docs.clear(); storage.deleted = []; storage.failOn = new Set() })

describe('pure parts', () => {
  test('a download URL and a gs:// path both resolve to bucket + object', () => {
    expect(C.storageObjectOf(url('kyc/AG1/applications/a b'))).toEqual({ bucket: BUCKET, path: 'kyc/AG1/applications/a b' })
    expect(C.storageObjectOf(`gs://${BUCKET}/hostPhotos/AG1/x`)).toEqual({ bucket: BUCKET, path: 'hostPhotos/AG1/x' })
    expect(C.storageObjectOf('https://example.com/v0/b/x/o/y')).toBe(null)
    expect(C.storageObjectOf('not a url')).toBe(null)
  })
  test('only a pending, never-redeemed invitation is a withdrawal', () => {
    expect(C.isWithdrawnInvitation(INVITE())).toBe(true)
    expect(C.isWithdrawnInvitation(INVITE({ status: 'approved' }))).toBe(false)
    expect(C.isWithdrawnInvitation(INVITE({ status: 'rejected' }))).toBe(false)
    expect(C.isWithdrawnInvitation(INVITE({ isActivated: true }))).toBe(false)
    expect(C.isWithdrawnInvitation(INVITE({ activatedByUid: 'U1' }))).toBe(false)
    expect(C.isWithdrawnInvitation(INVITE({ applicantUid: 'U1', source: 'self_app' }))).toBe(false)
  })
  test('an agency id that could leave its folder names no prefix', () => {
    expect(C.invitationUploadPrefixes('AG1')).toEqual(['kyc/AG1/applications/', 'hostPhotos/AG1/'])
    expect(C.invitationUploadPrefixes('')).toEqual([])
    expect(C.invitationUploadPrefixes('..')).toEqual([])
    expect(C.invitationUploadPrefixes('AG1/../AG2')).toEqual([])
  })
  test('a path that walks back out of the prefix is not inside it', () => {
    expect(C.isInside('kyc/AG1/applications/x', 'kyc/AG1/applications/')).toBe(true)
    expect(C.isInside('kyc/AG1/applications/../../AG2/applications/x', 'kyc/AG1/applications/')).toBe(false)
    expect(C.isInside('kyc/AG1/applications/', 'kyc/AG1/applications/')).toBe(false)
  })
})

describe('withdrawing a pending invitation deletes its uploads', () => {
  test('the photo and all three documents are deleted from the default bucket', async () => {
    await run(INVITE())
    expect(storage.deleted.sort()).toEqual([
      'hostPhotos/AG1/1700_photo',
      'kyc/AG1/applications/1700_doc1',
      'kyc/AG1/applications/1700_doc2',
      'kyc/AG1/applications/1700_doc3',
    ])
  })

  test('a file another application still references is kept', async () => {
    db.seed('hostApplications/HA2', { agencyId: 'AG1', status: 'pending', photoUrl: url('hostPhotos/AG1/1700_photo'),
      kycDocUrls: [url('kyc/AG1/applications/1700_doc2')] })
    const out = await C.cleanUpWithdrawnInvitation(INVITE())
    expect(storage.deleted.sort()).toEqual(['kyc/AG1/applications/1700_doc1', 'kyc/AG1/applications/1700_doc3'])
    expect(out.keptReferenced).toBe(2)
  })

  test('a photo a host\'s verification record compares against is kept', async () => {
    db.seed('hostVerification/U9', { agencyPhotoUrl: url('hostPhotos/AG1/1700_photo'), status: 'pending_capture' })
    await run(INVITE())
    expect(storage.deleted.includes('hostPhotos/AG1/1700_photo')).toBe(false)
    expect(storage.deleted.length).toBe(3)
  })

  test('a URL outside the inviting agency\'s own prefixes is never deleted', async () => {
    const out = await C.cleanUpWithdrawnInvitation(INVITE({
      photoUrl: url('hostPhotos/AG2/other_agency_photo'),
      kycDocUrls: [url('kyc/AG2/applications/d1'), url('kyc/agencies/AG1/agency_doc'), url('kyc/applicants/U1/x')],
    }))
    expect(storage.deleted).toEqual([])
    expect(out.skipped.outside_prefix).toBe(4)
  })

  test('a URL naming another bucket is not deleted', async () => {
    const out = await C.cleanUpWithdrawnInvitation(INVITE({ kycDocUrls: [url('kyc/AG1/applications/d1', 'someone-else')] }))
    expect(storage.deleted).toEqual(['hostPhotos/AG1/1700_photo'])
    expect(out.skipped.foreign_bucket).toBe(1)
  })

  test('when the reference check cannot be made, the file is KEPT', async () => {
    const real = db.collection.bind(db)
    db.collection = (name) => {
      const c = real(name)
      if (name !== 'hostVerification') return c
      return { where: () => ({ limit: () => ({ get: async () => { throw new Error('unavailable') } }) }) }
    }
    try {
      const out = await C.cleanUpWithdrawnInvitation(INVITE())
      expect(storage.deleted).toEqual([])
      expect(out.keptUnknown).toBe(4)
    } finally {
      db.collection = real
    }
  })

  test('one failed delete does not stop the others', async () => {
    storage.failOn.add('kyc/AG1/applications/1700_doc2')
    const out = await C.cleanUpWithdrawnInvitation(INVITE())
    expect(out.deleted).toBe(3)
    expect(out.failed).toBe(1)
  })
})

describe('anything that is not a withdrawn invitation keeps its files', () => {
  for (const [label, over] of [
    ['an approved application', { status: 'approved', kycStatus: 'approved' }],
    ['a rejected application (its files are the decision\'s evidence)', { status: 'rejected' }],
    ['a redeemed invitation', { isActivated: true, activatedByUid: 'U1' }],
    ['a self-filed application', { applicantUid: 'U1', source: 'self_app' }],
  ]) {
    test(label, async () => {
      await run(INVITE(over))
      expect(storage.deleted).toEqual([])
    })
  }
})

describe('wiring', () => {
  test('exported from index.ts, on hostApplications deletes, in the functions region', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(index.includes("export { onHostInvitationWithdrawn } from './invitationCleanup'")).toBe(true)
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'invitationCleanup.ts'), 'utf8')
    expect(src.includes(".firestore.document('hostApplications/{appId}')")).toBe(true)
    expect(src.includes('.onDelete(')).toBe(true)
    expect(src.includes(".region('asia-south1')")).toBe(true)
  })
  test('logs counts, never a URL (they carry access tokens)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'invitationCleanup.ts'), 'utf8')
    const logCall = src.slice(src.indexOf('functions.logger.info('))
    expect(logCall.slice(0, 400).includes('url')).toBe(false)
  })
})

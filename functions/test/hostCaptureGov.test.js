/**
 * GOV phase — the Host's own surfaces, executed against the shipped handlers.
 *
 *   B24  `submitHostCapture` trusted a client-sent URL, and the object behind
 *        it was overwritable after the comparison ran. Now the client URL is
 *        ignored: the server reads the capture at the one path it knows
 *        (`hostVerification/{uid}/capture.jpg`), COPIES it with the Admin SDK to
 *        an immutable per-attempt path, and stores that path. A repeat while
 *        the record is with a human overwrites nothing.
 *   B41  A revoked or removed Host, or a restricted one, could still submit a
 *        face capture and still take the PUBLISHER token for a live room
 *        opened before the revocation.
 *   B38  `onAgencyPhotoReplaced` read `activatedByUid` only, so a SELF-applied
 *        Host (named by `applicantUid`) never got the second attempt the
 *        re-upload is for.
 *
 * Firestore is the in-memory fake (`fakeFirestore.js`); Cloud Storage is a
 * recording stub installed here, the way `accountLifecycle.test.js` stubs it.
 * Nothing can reach a real project or the network.
 *
 * Run:  node --test test/hostCaptureGov.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
const db = installFakeFirestore()

// ── Cloud Storage: objects by name, and every copy made ──────────────────────
const storage = { objects: new Map(), copies: [], onCopy: null }
Object.defineProperty(admin, 'storage', {
  configurable: true,
  writable: true,
  value: () => ({
    bucket: () => ({
      file: (name) => ({
        name,
        exists: async () => [storage.objects.has(name)],
        copy: async (dest, opts) => {
          const to = typeof dest === 'string' ? dest : dest.name
          // `ifGenerationMatch: 0` is GCS for "only if nothing is there".
          if (opts && opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch === 0 &&
              storage.objects.has(to)) {
            throw Object.assign(new Error('412 Precondition Failed'), { code: 412 })
          }
          storage.objects.set(to, storage.objects.get(name))
          storage.copies.push({ from: name, to, opts })
          if (storage.onCopy) await storage.onCopy()
          return [{ name: to }]
        },
      }),
    }),
  }),
})

process.env.AGORA_APP_ID = 'a'.repeat(32)
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32)

const H = require('../lib/hosts')
const index = require('../lib/index')
const { HOST_REVOKED_REFUSAL } = require('../lib/hostEligibility')

const TOKEN = { auth_time: 2000, phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } }
const ctx = (uid) => ({ auth: { uid, token: TOKEN } })
const T1 = 1_800_000_000_000

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

const CAPTURE = 'hostVerification/U1/capture.jpg'
const currentHost = (extra = {}) =>
  db.seed('users/U1', { name: 'Asha', isHost: true, agencyId: 'AG1', isVerifiedHost: false, ...extra })
const revokedHost = () => db.seed('users/U1', {
  name: 'Asha', isHost: false, agencyId: 'AG1',
  hostRemovedAt: Timestamp.fromMillis(T1), hostRevokedAt: Timestamp.fromMillis(T1),
})
const openRecord = (extra = {}) => db.seed('hostVerification/U1', {
  uid: 'U1', status: 'pending_capture', agencyPhotoUrl: 'agencyPhotos/AG1/asha.jpg',
  agencyId: 'AG1', applicationId: 'HA1', attemptCount: 0, ...extra,
})
const submit = (data = {}) => H.submitHostCapture.run(data, ctx('U1'))

beforeEach(() => {
  db._docs.clear()
  storage.objects.clear()
  storage.copies = []
  storage.onCopy = null
})

// ══ B24 ══════════════════════════════════════════════════════════════════════

describe('B24 — the capture reviewed is the server\'s copy, never the client\'s URL', () => {
  test('the client URL is ignored; the server path is copied to an attempt and THAT is stored', async () => {
    currentHost()
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-1')

    const r = await submit({ captureUrl: 'https://evil.example/somebody-else.jpg' })
    expect(r.status).toBe('pending_manual')

    expect(storage.copies.length).toBe(1)
    const copy = storage.copies[0]
    expect(copy.from).toBe(CAPTURE)
    expect(/^hostVerification\/U1\/attempts\/[^/]+\.jpg$/.test(copy.to)).toBe(true)
    expect(copy.opts.preconditionOpts.ifGenerationMatch).toBe(0)
    expect(storage.objects.get(copy.to)).toBe('face-bytes-1')

    const ver = db.read('hostVerification/U1')
    expect(ver.captureUrl).toBe(copy.to)
    expect(ver.captureUrl.includes('evil.example')).toBe(false)
    expect(copy.to.endsWith(`/${ver.captureAttemptId}.jpg`)).toBe(true)
    expect(ver.attemptCount).toBe(1)
    expect(ver.status).toBe('pending_manual')
  })

  test('nothing at the server path → "No capture was uploaded.", whatever URL was sent', async () => {
    currentHost()
    openRecord()
    const e = await refusal(submit({ captureUrl: 'https://firebasestorage.example/o/hostVerification%2FU1%2Fcapture.jpg' }))
    expect(e && e.code).toBe('invalid-argument')
    expect(e.message).toBe('No capture was uploaded.')
    expect(storage.copies.length).toBe(0)
    expect(db.read('hostVerification/U1').status).toBe('pending_capture')
  })

  test('a repeat while pending_manual overwrites nothing — not the record, not the attempt', async () => {
    currentHost()
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-1')
    await submit()
    const stored = db.read('hostVerification/U1')

    // The host's scratch slot is replaced with a different face, and they submit again.
    storage.objects.set(CAPTURE, 'face-bytes-2')
    const r = await submit({ captureUrl: 'https://x' })
    expect(r).toEqual({ status: 'pending_manual', alreadyVerified: false })

    expect(storage.copies.length).toBe(1)
    const after = db.read('hostVerification/U1')
    expect(after.captureUrl).toBe(stored.captureUrl)
    expect(after.captureAttemptId).toBe(stored.captureAttemptId)
    expect(after.attemptCount).toBe(1)
    expect(storage.objects.get(stored.captureUrl)).toBe('face-bytes-1')
  })

  test('a submission that races one already under review does not overwrite it', async () => {
    currentHost()
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-2')
    // Between this call's read and its write, another submission lands.
    storage.onCopy = async () => {
      db.seed('hostVerification/U1', {
        ...db.read('hostVerification/U1'),
        status: 'pending_manual', captureUrl: 'hostVerification/U1/attempts/FIRST.jpg', attemptCount: 1,
      })
    }
    const r = await submit()
    expect(r.status).toBe('pending_manual')
    expect(db.read('hostVerification/U1').captureUrl).toBe('hostVerification/U1/attempts/FIRST.jpg')
    expect(db.read('hostVerification/U1').attemptCount).toBe(1)
  })

  test('no agency photograph: straight to a human, as before, and no attempt is copied', async () => {
    currentHost()
    openRecord({ agencyPhotoUrl: '' })
    storage.objects.set(CAPTURE, 'face-bytes-1')
    const r = await submit()
    expect(r).toEqual({ status: 'pending_manual', reason: 'no_agency_photo' })
    expect(storage.copies.length).toBe(0)
  })

  test('verified stays verified', async () => {
    currentHost({ isVerifiedHost: true })
    openRecord({ status: 'verified', captureUrl: 'hostVerification/U1/attempts/OLD.jpg' })
    storage.objects.set(CAPTURE, 'face-bytes-9')
    const r = await submit()
    expect(r).toEqual({ status: 'verified', alreadyVerified: true })
    expect(storage.copies.length).toBe(0)
    expect(db.read('hostVerification/U1').captureUrl).toBe('hostVerification/U1/attempts/OLD.jpg')
  })
})

// ══ B41 ══════════════════════════════════════════════════════════════════════

describe('B41 — only a current, unrestricted Host submits a face', () => {
  test('a revoked Host is refused with C1\'s sentence; nothing is copied or written', async () => {
    revokedHost()
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-1')
    const e = await refusal(submit())
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe('ROLE_REVOKED')
    expect(e.message).toBe(HOST_REVOKED_REFUSAL)
    expect(storage.copies.length).toBe(0)
    expect(db.read('hostVerification/U1').status).toBe('pending_capture')
  })

  test('somebody who is not a Host is refused', async () => {
    db.seed('users/U1', { name: 'Asha' })
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-1')
    const e = await refusal(submit())
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe('NOT_A_HOST')
    expect(storage.copies.length).toBe(0)
  })

  test('a suspended Host (the shape suspend_user writes) is refused', async () => {
    currentHost({ accountState: 'suspended', isBanned: true, isSuspended: true })
    openRecord()
    storage.objects.set(CAPTURE, 'face-bytes-1')
    const e = await refusal(submit())
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe('ACCOUNT_RESTRICTED')
    expect(e.details.state).toBe('suspended')
    expect(storage.copies.length).toBe(0)
  })
})

describe('B41 — the host token for an existing live room needs a current Host', () => {
  const token = (uid, channelName) => index.generateAgoraToken.run({ channelName, uid: 0 }, ctx(uid))

  test('a current Host still gets the token for their own room', async () => {
    currentHost({ isVerifiedHost: true })
    db.seed('liveRooms/LIVE1', { hostUid: 'U1', isActive: true })
    const r = await token('U1', 'LIVE1')
    expect(typeof r.token).toBe('string')
    expect(r.token.length).toBeGreaterThan(0)
  })

  test('a Host revoked after opening the room is refused, with the reason', async () => {
    revokedHost()
    db.seed('liveRooms/LIVE1', { hostUid: 'U1', isActive: true })
    const e = await refusal(token('U1', 'LIVE1'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe('ROLE_REVOKED')
  })

  test('a room owner who is not a Host at all is refused', async () => {
    db.seed('users/U1', { name: 'Asha', isHost: false })
    db.seed('liveRooms/LIVE1', { hostUid: 'U1', isActive: true })
    const e = await refusal(token('U1', 'LIVE1'))
    expect(e && e.details && e.details.code).toBe('NOT_A_HOST')
  })

  test('viewers are unaffected', async () => {
    db.seed('users/V1', { name: 'Viewer' })
    db.seed('liveRooms/LIVE1', { hostUid: 'U1', isActive: true })
    const r = await token('V1', 'LIVE1')
    expect(typeof r.token).toBe('string')
  })

  test('the PK channel: a revoked Host is refused, a current one is not', async () => {
    db.seed('liveRooms/LIVE1', { hostUid: 'U1', isActive: true, pkChannelId: 'pk_1' })
    revokedHost()
    expect((await refusal(token('U1', 'pk_1'))).details.code).toBe('ROLE_REVOKED')
    currentHost({ isVerifiedHost: true })
    expect(typeof (await token('U1', 'pk_1')).token).toBe('string')
  })
})

// ══ B38 ══════════════════════════════════════════════════════════════════════

describe('B38 — a re-uploaded agency photo reaches self-applied Hosts too', () => {
  const change = (after, id = 'HA9') => ({
    before: { data: () => ({ ...after, photoUrl: 'old.jpg' }) },
    after: { id, data: () => ({ ...after }) },
  })
  const replaced = (after, id) => H.onAgencyPhotoReplaced.run(change(after, id), { params: { appId: id || 'HA9' } })
  const record = (uid, extra) => db.seed(`hostVerification/${uid}`, {
    uid, status: 'rejected', agencyPhotoUrl: 'old.jpg', aiScore: 0.2, manualReason: 'no_match', ...extra,
  })

  test('a self-applied Host (applicantUid only) on the application the record came from gets another attempt', async () => {
    record('S1', { applicationId: 'HA9', agencyId: 'AG1' })
    await replaced({ photoUrl: 'new.jpg', applicantUid: 'S1', agencyId: 'AG1' })
    const ver = db.read('hostVerification/S1')
    expect(ver.agencyPhotoUrl).toBe('new.jpg')
    expect(ver.status).toBe('pending_capture')
    expect(ver.aiScore).toBe(null)
  })

  test('…but not from an OLD application of theirs the record was not opened from', async () => {
    record('S1', { applicationId: 'HA-CURRENT', agencyId: 'AG1' })
    await replaced({ photoUrl: 'new.jpg', applicantUid: 'S1', agencyId: 'AG1' })
    expect(db.read('hostVerification/S1').agencyPhotoUrl).toBe('old.jpg')
    expect(db.read('hostVerification/S1').status).toBe('rejected')
  })

  test('a record naming no application is matched on the agency', async () => {
    record('S1', { agencyId: 'AG1' })
    await replaced({ photoUrl: 'new.jpg', applicantUid: 'S1', agencyId: 'AG2' })
    expect(db.read('hostVerification/S1').agencyPhotoUrl).toBe('old.jpg')
    await replaced({ photoUrl: 'new.jpg', applicantUid: 'S1', agencyId: 'AG1' })
    expect(db.read('hostVerification/S1').agencyPhotoUrl).toBe('new.jpg')
  })

  test('a verified self-applied Host keeps the badge', async () => {
    record('S1', { status: 'verified', applicationId: 'HA9' })
    await replaced({ photoUrl: 'new.jpg', applicantUid: 'S1' })
    expect(db.read('hostVerification/S1').status).toBe('verified')
    expect(db.read('hostVerification/S1').agencyPhotoUrl).toBe('old.jpg')
  })

  test('an invitation Host (activatedByUid) is reopened exactly as before', async () => {
    record('H1', { applicationId: 'HA-OTHER' })
    await replaced({ photoUrl: 'new.jpg', activatedByUid: 'H1' })
    expect(db.read('hostVerification/H1').agencyPhotoUrl).toBe('new.jpg')
    expect(db.read('hostVerification/H1').status).toBe('pending_capture')
  })
})

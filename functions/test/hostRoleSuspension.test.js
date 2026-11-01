/**
 * §5 Partner role suspension, for the HOST role — the server half in Functions.
 *
 * "Temporary restriction of only the selected capability … block role-specific
 * dashboards/actions and new role transactions; keep the role slot/record while
 * suspended; resume the same record." The backend (`users.suspend_host`) writes
 * `hostSuspended: true` (+ `hostSuspendedUntil` / `hostSuspendedReason`) and
 * leaves `isHost`, the verification, the agency link and the earnings alone.
 * Here: every Host-only callable refuses while that flag is exactly `true`, with
 * `details.code = HOST_ROLE_SUSPENDED` and the sentence
 * "Your Host role is suspended until … — reason: …"; somebody calling the
 * suspended host is told only HOST_UNAVAILABLE; a viewer / user path, and the
 * beans already earned, are untouched; and NOTHING here is ACCOUNT_RESTRICTED
 * (the app signs a device out on that code — the account is not restricted).
 *
 * REAL: hostEligibility (pure), and the shipped handlers in hosts, hostStats,
 * calls and index over the in-memory Firestore (`fakeFirestore.js`). Firebase
 * Auth and Cloud Storage are recording stubs; nothing reaches a project.
 *
 * Run:  node --test test/hostRoleSuspension.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')

const { installFakeFirestore, Timestamp } = require('./fakeFirestore')
const db = installFakeFirestore()

// Firebase Auth records (identityFor / contactProofFor read these).
const records = new Map()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => {
      if (!records.has(uid)) throw new Error('auth/user-not-found')
      return { uid, ...records.get(uid) }
    },
    revokeRefreshTokens: async () => undefined,
  }),
})

// Cloud Storage: a capture that is there, and every copy made (none should be).
const storage = { objects: new Map(), copies: [] }
Object.defineProperty(admin, 'storage', {
  configurable: true, writable: true,
  value: () => ({
    bucket: () => ({
      file: (name) => ({
        name,
        exists: async () => [storage.objects.has(name)],
        copy: async (dest) => {
          const to = typeof dest === 'string' ? dest : dest.name
          storage.copies.push({ from: name, to })
          return [{ name: to }]
        },
      }),
    }),
  }),
})

process.env.AGORA_APP_ID = 'a'.repeat(32)
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32)

const E = require('../lib/hostEligibility')
const H = require('../lib/hosts')
const stats = require('../lib/hostStats')
const calls = require('../lib/calls')
const index = require('../lib/index')

const {
  hostRoleSuspension, hostSuspendedMessage, hostSuspensionDetails, whenUtc, refusalDetails,
  activeHostRefusal, HOST_ROLE_SUSPENDED, HOST_UNAVAILABLE, HOST_UNAVAILABLE_REFUSAL,
  ROLE_REVOKED, NOT_A_HOST, HOST_REVOKED_REFUSAL,
} = E

/** A user document, as `tx.get(userRef)` hands it over. */
const snap = (fields) => ({ get: (key) => fields[key] })
const at = (ms) => ({ toMillis: () => ms })

// 04 Nov 2026, 10:15 UTC — the end of a timed suspension.
const UNTIL_MS = Date.UTC(2026, 10, 4, 10, 15)
const WHY = 'Repeated no-shows on booked calls'
const MSG_TIMED = `Your Host role is suspended until 04 Nov 2026, 10:15 UTC — reason: ${WHY}`
const MSG_OPEN = `Your Host role is suspended until it is resumed — reason: ${WHY}`

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

// ══ The rule, pure ═══════════════════════════════════════════════════════════

describe('hostRoleSuspension — the flag, strictly, and nothing else', () => {
  test('no flag, false, or a truthy non-boolean → not suspended', () => {
    expect(hostRoleSuspension(snap({ isHost: true }))).toBeNull()
    expect(hostRoleSuspension(snap({ isHost: true, hostSuspended: false, hostSuspendedReason: WHY }))).toBeNull()
    expect(hostRoleSuspension(snap({ isHost: true, hostSuspended: 'true' }))).toBeNull()
    expect(hostRoleSuspension(snap({ isHost: true, hostSuspended: 1 }))).toBeNull()
  })

  test('a timed suspension: the end as ISO (UTC) and millis, the reason trimmed', () => {
    const s = hostRoleSuspension(snap({
      isHost: true, hostSuspended: true, hostSuspendedUntil: at(UNTIL_MS), hostSuspendedReason: `  ${WHY} `,
    }))
    expect(s).toEqual({ until: new Date(UNTIL_MS).toISOString(), untilMs: UNTIL_MS, reason: WHY })
    expect(s.until).toBe('2026-11-04T10:15:00.000Z')
  })

  test('the SDK\'s own Timestamp and a Date are read the same way', () => {
    for (const until of [Timestamp.fromMillis(UNTIL_MS), new Date(UNTIL_MS)]) {
      expect(hostRoleSuspension(snap({ hostSuspended: true, hostSuspendedUntil: until })).untilMs).toBe(UNTIL_MS)
    }
  })

  test('no end date (absent) = until resumed; an unreadable one is not guessed', () => {
    expect(hostRoleSuspension(snap({ hostSuspended: true, hostSuspendedReason: WHY })))
      .toEqual({ until: null, untilMs: null, reason: WHY })
    expect(hostRoleSuspension(snap({ hostSuspended: true, hostSuspendedUntil: 'not a date' })).until).toBeNull()
  })

  test('NO read-time expiry: an end date in the past still refuses until the backend resumes it', () => {
    // The daily sweep (`users.lift_expired_host_suspensions`) lifts it and writes
    // the audit entry and the notices; the gate does not guess ahead of it.
    const s = hostRoleSuspension(snap({ hostSuspended: true, hostSuspendedUntil: at(Date.now() - 86_400_000) }))
    expect(s === null).toBe(false)
  })
})

describe('the sentence and the details — word for word', () => {
  test('timed, with a reason', () => {
    expect(hostSuspendedMessage({ until: '2026-11-04T10:15:00.000Z', untilMs: UNTIL_MS, reason: WHY })).toBe(MSG_TIMED)
  })
  test('indefinite: "until it is resumed"', () => {
    expect(hostSuspendedMessage({ until: null, untilMs: null, reason: WHY })).toBe(MSG_OPEN)
  })
  test('no reason on record: the "— reason:" part is left off, not left empty', () => {
    expect(hostSuspendedMessage({ until: null, untilMs: null, reason: '' }))
      .toBe('Your Host role is suspended until it is resumed')
    expect(hostSuspendedMessage({ until: '2026-11-04T10:15:00.000Z', untilMs: UNTIL_MS, reason: '' }))
      .toBe('Your Host role is suspended until 04 Nov 2026, 10:15 UTC')
  })
  test('the date is the backend\'s `email.when` format: zero-padded, UTC, 24-hour', () => {
    expect(whenUtc(Date.UTC(2027, 0, 5, 3, 7))).toBe('05 Jan 2027, 03:07 UTC')
    expect(whenUtc(Date.UTC(2026, 11, 31, 23, 59))).toBe('31 Dec 2026, 23:59 UTC')
  })
  test('details: code, until (ISO or null) and reason', () => {
    expect(hostSuspensionDetails({ until: null, untilMs: null, reason: WHY }))
      .toEqual({ code: 'HOST_ROLE_SUSPENDED', until: null, reason: WHY })
    expect(HOST_ROLE_SUSPENDED).toBe('HOST_ROLE_SUSPENDED')
    expect(HOST_UNAVAILABLE).toBe('HOST_UNAVAILABLE')
    expect(HOST_UNAVAILABLE_REFUSAL).toBe('This host is not taking calls right now.')
  })
})

describe('activeHostRefusal — restricted → revoked → not a host → suspended', () => {
  const suspended = { isHost: true, hostSuspended: true, hostSuspendedUntil: at(UNTIL_MS), hostSuspendedReason: WHY }

  test('a suspended current Host is refused with the sentence, the term and the reason', () => {
    const r = activeHostRefusal(snap(suspended))
    expect(r).toEqual({
      code: HOST_ROLE_SUSPENDED, message: MSG_TIMED, until: '2026-11-04T10:15:00.000Z', reason: WHY,
    })
    expect(refusalDetails(r)).toEqual({ code: HOST_ROLE_SUSPENDED, until: '2026-11-04T10:15:00.000Z', reason: WHY })
  })
  test('a resumed Host (hostSuspended: false, stamps kept) acts as a Host again', () => {
    expect(activeHostRefusal(snap({ isHost: true, hostSuspended: false, hostResumedAt: at(UNTIL_MS) }))).toBeNull()
  })
  test('a restricted ACCOUNT outranks the role suspension (the session gate\'s code)', () => {
    expect(activeHostRefusal(snap({ ...suspended, accountState: 'suspended', isSuspended: true, isBanned: true })).code)
      .toBe('ACCOUNT_RESTRICTED')
  })
  test('a revoked role outranks a suspension left on the document', () => {
    const r = activeHostRefusal(snap({ ...suspended, isHost: false, hostRevokedAt: at(UNTIL_MS) }))
    expect(r.code).toBe(ROLE_REVOKED)
    expect(r.message).toBe(HOST_REVOKED_REFUSAL)
  })
  test('somebody who holds no Host role is told that, not about a suspension', () => {
    expect(activeHostRefusal(snap({ hostSuspended: true, hostSuspendedReason: WHY })).code).toBe(NOT_A_HOST)
  })
  test('a role suspension is NEVER reported as ACCOUNT_RESTRICTED', () => {
    expect(activeHostRefusal(snap(suspended)).code).not.toBe('ACCOUNT_RESTRICTED')
  })
  test('details for the other refusals stay `{ code }` only', () => {
    expect(refusalDetails({ code: NOT_A_HOST, message: 'This is for hosts only.' })).toEqual({ code: NOT_A_HOST })
  })
})

// ══ The shipped handlers ═════════════════════════════════════════════════════

const TOKEN = { auth_time: 2000, phone_number: '+919876543210', email: 'host@example.test', email_verified: true,
  firebase: { sign_in_provider: 'phone' } }
const ctx = (uid) => ({ auth: { uid, token: TOKEN } })
const v2 = (fn, uid, data) => fn.run({ data, auth: { uid, token: TOKEN } })

/**
 * The shape `users.suspend_host` leaves: the role, the record and the money
 * untouched. `hostSuspendedUntil: null` in `extra` seeds the indefinite kind,
 * which the backend writes by leaving the field off.
 */
const suspendedHost = (uid = 'H1', extra = {}) => {
  const doc = {
    name: 'Asha', isHost: true, isVerifiedHost: true, agencyId: 'AG1', callRateBeans: 500,
    beans: 1200, hostCallEarnings: 900, hostGiftEarnings: 300,
    hostSuspended: true, hostSuspendedUntil: Timestamp.fromMillis(UNTIL_MS), hostSuspendedReason: WHY,
    hostSuspensionDays: 3, hostStatusBeforeSuspension: 'active',
    hostSuspendedBy: 'ops-1', hostSuspendedByName: 'Ops Admin', hostSuspendedByRole: 'ops_admin',
    hostSuspendedAt: Timestamp.fromMillis(UNTIL_MS - 3 * 86_400_000),
    ...extra,
  }
  if (doc.hostSuspendedUntil === null) {
    delete doc.hostSuspendedUntil
    delete doc.hostSuspensionDays
  }
  return db.seed(`users/${uid}`, doc)
}
const currentHost = (uid = 'H1', extra = {}) => db.seed(`users/${uid}`, {
  name: 'Asha', isHost: true, isVerifiedHost: true, agencyId: 'AG1', callRateBeans: 500, beans: 1200, ...extra,
})

beforeEach(() => {
  db._docs.clear()
  records.clear()
  storage.objects.clear()
  storage.copies = []
})

describe('generateAgoraToken — the publisher token for a suspended Host is refused; watching is not', () => {
  const token = (uid, channelName) => index.generateAgoraToken.run({ channelName, uid: 0 }, ctx(uid))

  test('their own live room: permission-denied, HOST_ROLE_SUSPENDED, the term and the reason', async () => {
    suspendedHost()
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true })
    const e = await refusal(token('H1', 'LIVE1'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toBe(MSG_TIMED)
    expect(e.details).toEqual({ code: HOST_ROLE_SUSPENDED, until: '2026-11-04T10:15:00.000Z', reason: WHY })
  })

  test('their PK channel too', async () => {
    suspendedHost()
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true, pkChannelId: 'pk_1' })
    const e = await refusal(token('H1', 'pk_1'))
    expect(e && e.details && e.details.code).toBe(HOST_ROLE_SUSPENDED)
  })

  test('a viewer feature is unaffected: the suspended Host watches someone else\'s room', async () => {
    suspendedHost()
    db.seed('users/H2', { name: 'Other', isHost: true, isVerifiedHost: true })
    db.seed('liveRooms/LIVE2', { hostUid: 'H2', isActive: true })
    const r = await token('H1', 'LIVE2')
    expect(r.role).toBe('subscriber')
  })

  test('control: resumed (hostSuspended: false) → the publisher token is issued', async () => {
    currentHost('H1', { hostSuspended: false })
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true })
    expect((await token('H1', 'LIVE1')).role).toBe('publisher')
  })
})

describe('getHostHome — the Host dashboard is closed, the earnings are not touched', () => {
  test('refused with the sentence and the details; beans and lifetime earnings unchanged', async () => {
    suspendedHost()
    const e = await refusal(stats.getHostHome.run({}, ctx('H1')))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toBe(MSG_TIMED)
    expect(e.details.code).toBe(HOST_ROLE_SUSPENDED)
    const u = db.read('users/H1')
    expect([u.beans, u.hostCallEarnings, u.hostGiftEarnings, u.isHost, u.isVerifiedHost]).toEqual([1200, 900, 300, true, true])
  })
  test('an indefinite suspension says "until it is resumed"', async () => {
    suspendedHost('H1', { hostSuspendedUntil: null })
    const e = await refusal(stats.getHostHome.run({}, ctx('H1')))
    expect(e.message).toBe(MSG_OPEN)
    expect(e.details).toEqual({ code: HOST_ROLE_SUSPENDED, until: null, reason: WHY })
  })
  test('control: a current Host gets the home screen', async () => {
    currentHost()
    const r = await stats.getHostHome.run({}, ctx('H1'))
    expect(r.payout.beans).toBe(1200)
  })
})

describe('setCallRate — no new price while the role is suspended', () => {
  test('refused, and the agreed rate stands for the resume', async () => {
    suspendedHost()
    const e = await refusal(H.setCallRate.run({ callRateBeans: 600 }, ctx('H1')))
    expect(e && e.code).toBe('permission-denied')
    expect(e.details.code).toBe(HOST_ROLE_SUSPENDED)
    expect(db.read('users/H1').callRateBeans).toBe(500)
  })
  test('control: a current verified Host sets it', async () => {
    currentHost()
    db.seed('appConfig/economy', { minHostCallRate: 100 })
    const r = await H.setCallRate.run({ callRateBeans: 600 }, ctx('H1'))
    expect(r.callRateBeans).toBe(600)
  })
})

describe('submitHostCapture — no face is submitted while suspended', () => {
  test('refused before anything is read from Storage or copied', async () => {
    suspendedHost('H1', { isVerifiedHost: false })
    db.seed('hostVerification/H1', { uid: 'H1', status: 'pending_capture', agencyPhotoUrl: 'agencyPhotos/AG1/a.jpg' })
    storage.objects.set('hostVerification/H1/capture.jpg', 'bytes')
    const e = await refusal(H.submitHostCapture.run({}, ctx('H1')))
    expect(e && e.code).toBe('permission-denied')
    expect(e.details).toEqual({ code: HOST_ROLE_SUSPENDED, until: '2026-11-04T10:15:00.000Z', reason: WHY })
    expect(storage.copies.length).toBe(0)
    expect(db.read('hostVerification/H1').status).toBe('pending_capture')
  })
})

describe('activateHost / checkReferralCode — a code is not a way round the suspension', () => {
  const PHONE = TOKEN.phone_number
  const EMAIL = TOKEN.email
  function invitation() {
    records.set('H1', { phoneNumber: PHONE, email: EMAIL, emailVerified: true, providerData: [] })
    db.seed('agencies/AG1', { referralCode: 'ABC123', status: 'approved', isActive: true })
    db.seed('appConfig/economy', { minHostCallRate: 100, maxHostCallRate: 700 })
    db.seed('hostApplications/HA1', {
      referralCode: 'ABC123', agencyId: 'AG1', hostName: 'Asha',
      applicantPhone: PHONE, applicantEmail: EMAIL, callRate: 300,
      isActivated: false, status: 'approved', kycStatus: 'approved',
      decidedByUid: 'uidReviewer', decidedAt: new Date(),
    })
  }

  test('activateHost refuses (failed-precondition + details); nothing is written', async () => {
    invitation()
    suspendedHost()
    const e = await refusal(H.activateHost.run({ referralCode: 'ABC123' }, ctx('H1')))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe(MSG_TIMED)
    expect(e.details.code).toBe(HOST_ROLE_SUSPENDED)
    expect(db.read('hostApplications/HA1').isActivated).toBe(false)
    expect(db.read('users/H1').hostSuspended).toBe(true)
    expect(db.has('agencies/AG1/agencyHosts/H1')).toBe(false)
    expect(db.has('hostVerification/H1')).toBe(false)
  })

  test('checkReferralCode asks the same question and carries the sentence', async () => {
    invitation()
    suspendedHost()
    const r = await H.checkReferralCode.run({ referralCode: 'ABC123' }, ctx('H1'))
    expect(r).toEqual({ valid: false, reason: 'host_suspended', code: HOST_ROLE_SUSPENDED, message: MSG_TIMED })
  })
})

// ── Calls ────────────────────────────────────────────────────────────────────

const CALL = 'CALL1'
const ago = (sec) => Timestamp.fromMillis(Date.now() - sec * 1000)
const startCall = (caller, peer, key = 'k1') => v2(calls.startCall, caller, { peerUid: peer, idempotencyKey: key })
const user = (uid, extra = {}) => db.seed(`users/${uid}`, { name: uid, diamonds: 5000, ...extra })

describe('startCall — a suspended Host takes no new paid call; the caller is not told why', () => {
  test('a USER ringing a suspended Host: HOST_UNAVAILABLE, no reason, no call document', async () => {
    user('U1')
    suspendedHost()
    const e = await refusal(startCall('U1', 'H1'))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe(HOST_UNAVAILABLE_REFUSAL)
    expect(e.details).toEqual({ code: HOST_UNAVAILABLE })
    expect(e.message.includes(WHY)).toBe(false)
    expect(db.count('calls')).toBe(0)
    expect(db.read('users/U1').diamonds).toBe(5000)
  })

  test('the suspended Host ringing a user (they would EARN): their own sentence and details', async () => {
    user('U1')
    suspendedHost()
    const e = await refusal(startCall('H1', 'U1'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toBe(MSG_TIMED)
    expect(e.details.code).toBe(HOST_ROLE_SUSPENDED)
    expect(db.count('calls')).toBe(0)
  })

  test('the suspended Host ringing ANOTHER Host (they PAY, a user feature) is let through', async () => {
    suspendedHost('H1', { diamonds: 5000 })
    currentHost('H2')
    const r = await startCall('H1', 'H2')
    expect(typeof r.callId).toBe('string')
    expect(db.read(`calls/${r.callId}`).earner).toBe('receiver')
    expect(db.read(`calls/${r.callId}`).callerId).toBe('H1')
  })

  test('control: a user ringing a current Host rings', async () => {
    user('U1')
    currentHost()
    const r = await startCall('U1', 'H1')
    expect(db.read(`calls/${r.callId}`).status).toBe('ringing')
  })
})

describe('acceptCall — suspended while it rang: closed, the first minute never taken', () => {
  const ringing = (caller, receiver, earner) => db.seed(`calls/${CALL}`, {
    callerId: caller, receiverId: receiver, earner, status: 'ringing',
    perMinRateDiamonds: 60, receiverPct: 50, startedAt: null, tickIndex: 0, billingUnit: 'minute',
    billedThroughMs: null, diamondsCharged: 0, beansCredited: 0, createdAt: ago(5),
  })
  const accept = (uid) => v2(calls.acceptCall, uid, { callId: CALL })

  test('the suspended Host picks up a user\'s call: their sentence; ring closed host_suspended; no money', async () => {
    user('U1')
    suspendedHost()
    ringing('U1', 'H1', 'receiver')
    const e = await refusal(accept('H1'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toBe(MSG_TIMED)
    expect(e.details.code).toBe(HOST_ROLE_SUSPENDED)
    const c = db.read(`calls/${CALL}`)
    expect([c.status, c.endReason, c.tickIndex]).toEqual(['declined', 'host_suspended', 0])
    expect(db.read('users/U1').diamonds).toBe(5000)
    expect(db.read('users/H1').beans).toBe(1200)
    expect(db.read(`callHistory/${CALL}`).endReason).toBe('host_suspended')
  })

  test('a user picks up a call a since-suspended Host placed: HOST_UNAVAILABLE, no reason', async () => {
    user('U1')
    suspendedHost()
    ringing('H1', 'U1', 'caller')
    const e = await refusal(accept('U1'))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.details).toEqual({ code: HOST_UNAVAILABLE })
    expect(e.message.includes(WHY)).toBe(false)
    expect(db.read(`calls/${CALL}`).endReason).toBe('host_suspended')
    expect(db.read('users/U1').diamonds).toBe(5000)
  })
})

describe('tickCall — suspended mid-call: ended at the gate, minutes already charged stay', () => {
  const connected = () => db.seed(`calls/${CALL}`, {
    callerId: 'U1', receiverId: 'H1', earner: 'receiver', status: 'connected',
    perMinRateDiamonds: 60, receiverPct: 50, billingUnit: 'minute',
    startedAt: ago(95), lastTickAt: ago(5), tickIndex: 1, diamondsCharged: 60, beansCredited: 30,
  })
  const tick = (uid) => v2(calls.tickCall, uid, { callId: CALL })
  const end = (uid) => v2(calls.endCall, uid, { callId: CALL, reason: 'user_ended' })

  test('the payer\'s tick ends it host_suspended and charges nothing more; settlement keeps the reason', async () => {
    user('U1', { diamonds: 940 })
    suspendedHost()
    connected()
    const r = await tick('U1')
    expect([r.endNow, r.status, r.endReason, r.charged]).toEqual([true, 'ending', 'host_suspended', 0])
    expect(db.read('users/U1').diamonds).toBe(940)
    const closed = await end('U1')
    expect(closed.endReason).toBe('host_suspended')
    expect(db.read(`calls/${CALL}`).status).toBe('ended')
    // Billed through the gate instant only (minute 2 had started at 60 s), and
    // the beans earned before the suspension are still the host's.
    expect(db.read('users/H1').beans).toBeGreaterThanOrEqual(1200)
  })

  test('control: a current Host\'s call bills on', async () => {
    user('U1', { diamonds: 940 })
    currentHost()
    connected()
    const r = await tick('U1')
    expect(r.endNow).toBe(false)
    expect(r.charged).toBe(60)
  })
})

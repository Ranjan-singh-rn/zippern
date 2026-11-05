/**
 * P0-1 (N4) — the sign-in behind a token must not predate the account's cut-off.
 *
 * `startMobileSession` stamps `users/{uid}.credentialsValidAfter` with the
 * caller's own `auth_time`, and the rules' `sessionCurrent()` has always refused
 * a DIRECT write whose `auth_time` is older. The callables did not: they
 * compared a session id only when one was presented, and while
 * `ENFORCE_MOBILE_SESSION` is off an omitted id was waved through. So a
 * displaced device — or any old or modified client — simply left the id out and
 * kept spending, calling and joining rooms on a token the account had already
 * moved past.
 *
 * Now every protected callable refuses `auth_time < credentialsValidAfter`
 * WHETHER OR NOT an id is sent, and a missing or future `auth_time` on an
 * account that has a cut-off is refused too (fail closed). The id comparison
 * is unchanged and still runs after this one.
 *
 * Run:  node --test test/sessionCutoffP0.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [] }),
    createCustomToken: async (uid) => `t-${uid}`,
    revokeRefreshTokens: async () => undefined,
    setCustomUserClaims: async () => undefined,
  }),
})

const mobileSession = require('../lib/mobileSession')
const party = require('../lib/party')
const calls = require('../lib/calls')
const gifts = require('../lib/gifts')
const wallet = require('../lib/wallet')
const hosts = require('../lib/hosts')
const social = require('../lib/social')
const index = require('../lib/index')
const emailOtp = require('../lib/emailOtp')

const UID = 'U1'
const CURRENT = 'SESSION-NOW'
const tok = (authTime) => ({
  ...(authTime === undefined ? {} : { auth_time: authTime }),
  phone_number: '+919800000001',
  firebase: { sign_in_provider: 'phone' },
})

const v1 = (fn) => (data, token) => fn.run(data, { auth: { uid: UID, token } })
const v2 = (fn) => (data, token) => fn.run({ data, auth: { uid: UID, token } })

// The same 26 callables `sessionCoveragePhase1a.test.js` runs, plus the two
// UGP-C email-code callables (28).
const GUARDED = [
  ['startCall', v2(calls.startCall), { peerUid: 'P' }],
  ['acceptCall', v2(calls.acceptCall), { callId: 'C' }],
  ['settleGift', v2(gifts.settleGift), { giftId: 'g', receiverUid: 'R' }],
  ['convertBeans', v1(wallet.convertBeans), { beansAmount: 10 }],
  ['claimDailyReward', v1(wallet.claimDailyReward), {}],
  ['purchaseBagItem', v1(wallet.purchaseBagItem), { itemId: 'i' }],
  ['equipBagItem', v1(wallet.equipBagItem), { itemId: 'i' }],
  ['activateHost', v1(hosts.activateHost), { referralCode: 'ABC123' }],
  ['setCallRate', v1(hosts.setCallRate), { callRateBeans: 500 }],
  ['submitHostCapture', v1(hosts.submitHostCapture), { captureUrl: 'https://x' }],
  ['toggleLike', v1(social.toggleLike), { targetUid: 'T', like: true }],
  ['createPartyRoom', v1(party.createPartyRoom), { mode: 'audio' }],
  ['updatePartyRoom', v1(party.updatePartyRoom), { roomId: 'R' }],
  ['joinPartyRoom', v1(party.joinPartyRoom), { roomId: 'R' }],
  ['takePartySeat', v1(party.takePartySeat), { roomId: 'R', seatIndex: 1 }],
  ['requestPartySeat', v1(party.requestPartySeat), { roomId: 'R', seatIndex: 1 }],
  ['decidePartySeatRequest', v1(party.decidePartySeatRequest), { roomId: 'R', targetUid: 'T', approve: true }],
  ['invitePartySeat', v1(party.invitePartySeat), { roomId: 'R', targetUid: 'T', seatIndex: 1 }],
  ['respondPartySeatInvite', v1(party.respondPartySeatInvite), { roomId: 'R', accept: true }],
  ['setPartySeatMute', v1(party.setPartySeatMute), { roomId: 'R', seatIndex: 1, muted: true }],
  ['setPartySeatLock', v1(party.setPartySeatLock), { roomId: 'R', seatIndex: 1, locked: true }],
  ['setPartyAdmin', v1(party.setPartyAdmin), { roomId: 'R', targetUid: 'T', isAdmin: true }],
  ['generateAgoraToken', v1(index.generateAgoraToken), { channelName: 'party_R', uid: 0 }],
  ['submitPartnerApplication', v1(index.submitPartnerApplication), { kind: 'agency', form: {} }],
  ['submitHostApplication', v1(index.submitHostApplication), { parentId: 'AG1', form: {} }],
  ['submitRechargeRequest', v1(index.submitRechargeRequest), { diamonds: 10, amountMinor: 100, sellerId: 'S' }],
  ['requestEmailBindCode', v1(emailOtp.requestEmailBindCode), { email: 'x@example.test' }],
  ['verifyEmailBindCode', v1(emailOtp.verifyEmailBindCode), { email: 'x@example.test', code: '123456' }],
]

async function outcome(p) {
  try { await p; return { ok: true } } catch (e) { return { ok: false, code: e.code, detail: e.details && e.details.code } }
}
const GATE_CODES = ['SESSION_DISPLACED', 'ACCOUNT_RESTRICTED']

describe('signInPredatesCutoff — the pure decision', () => {
  const f = (a, b) => mobileSession.signInPredatesCutoff(a, b, 10_000)
  test('no cut-off recorded → never stale', () => {
    expect(f(undefined, 1)).toBe(false)
    expect(f(0, 1)).toBe(false)
    expect(f(null, undefined)).toBe(false)
  })
  test('auth_time before the cut-off → stale', () => expect(f(3000, 2999)).toBe(true))
  test('auth_time equal to the cut-off → current (the device that set it)', () => expect(f(3000, 3000)).toBe(false))
  test('auth_time after the cut-off → current', () => expect(f(3000, 3001)).toBe(false))
  test('a cut-off and NO auth_time → stale (fail closed)', () => {
    expect(f(3000, undefined)).toBe(true)
    expect(f(3000, '3001')).toBe(true)
    expect(f(3000, 0)).toBe(true)
  })
  test('an auth_time in the future (beyond clock skew) → stale', () => expect(f(3000, 10_000 + 3600)).toBe(true))
})

describe('every protected callable refuses a sign-in older than the cut-off — with or without an id', () => {
  beforeEach(() => { db._docs.clear(); delete process.env.ENFORCE_MOBILE_SESSION })
  for (const [name, invoke, data] of GUARDED) {
    test(`${name} — stale auth_time, NO session id → SESSION_DISPLACED`, async () => {
      db.seed(`users/${UID}`, { name: 'u', credentialsValidAfter: 3000, activeMobileSession: { sessionId: CURRENT } })
      const r = await outcome(invoke({ ...data }, tok(2000)))
      expect(r.ok).toBe(false)
      expect(r.code).toBe('permission-denied')
      expect(r.detail).toBe('SESSION_DISPLACED')
    })
    test(`${name} — stale auth_time presenting the CURRENT id → SESSION_DISPLACED`, async () => {
      db.seed(`users/${UID}`, { name: 'u', credentialsValidAfter: 3000, activeMobileSession: { sessionId: CURRENT } })
      const r = await outcome(invoke({ ...data, sessionId: CURRENT }, tok(2000)))
      expect(r.detail).toBe('SESSION_DISPLACED')
    })
    test(`${name} — no auth_time on an account with a cut-off → SESSION_DISPLACED`, async () => {
      db.seed(`users/${UID}`, { name: 'u', credentialsValidAfter: 3000 })
      const r = await outcome(invoke({ ...data }, tok(undefined)))
      expect(r.detail).toBe('SESSION_DISPLACED')
    })
    test(`${name} — auth_time EQUAL to the cut-off, no id → not refused by the gate`, async () => {
      db.seed(`users/${UID}`, { name: 'u', credentialsValidAfter: 2000, activeMobileSession: { sessionId: CURRENT } })
      const r = await outcome(invoke({ ...data }, tok(2000)))
      expect(GATE_CODES.includes(r.detail)).toBe(false)
    })
    test(`${name} — no cut-off recorded, no id (staged rollout) → not refused by the gate`, async () => {
      db.seed(`users/${UID}`, { name: 'u' })
      const r = await outcome(invoke({ ...data }, tok(2000)))
      expect(GATE_CODES.includes(r.detail)).toBe(false)
    })
  }
})

describe('every call site hands its token to the gate', () => {
  const SRC = path.join(__dirname, '..', 'src')
  const sites = []
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8')
    const re = /await assertActiveSession\(([^)]*)\)/g
    let m
    while ((m = re.exec(text)) !== null) sites.push([file, m[1]])
  }
  // 28 callables, plus the one in `bindVerifiedIdentity` that gates only the
  // same-uid session token (the bind itself stays ungated) — 29.
  // 30 since Decision 15 (RC): `checkPartnerActivation`, which can start an
  // Owner-approved role once both contacts are verified, is a protected
  // operation like the application it follows.
  // 31 since B7 (3 Nov 2026): `subscribePrivateRooms` takes diamonds for Party Pro — a protected operation.
  // 34 since B12 (4 Nov 2026): `pkMatch`, `pkRespond` and `pkEnd` (live.ts) write both hosts' rooms for a PK
  // battle — protected operations like every other room action.
  // 35 since O14 (5 Nov 2026): `setPartyMusic` (party.ts) — the room's music, like every other room control.
  // 36 since O8 (5 Nov 2026): `claimDailyTask` (dailyTasks.ts) pays a daily task's reward — money, like the daily reward.
  // (The game callables live in src/games/ and gate the same way; this count covers src/*.ts only.)
  test('there are exactly 36 gated call sites', () => expect(sites.length).toBe(36))
  for (const [file, args] of sites) {
    test(`${file}: assertActiveSession(${args.split(',')[2]?.trim() ?? ''}, …) passes the auth token`, () => {
      expect(/context\.auth\?\.token\s*$/.test(args.trim())).toBe(true)
    })
  }
})

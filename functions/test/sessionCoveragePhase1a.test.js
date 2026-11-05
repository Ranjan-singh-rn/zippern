/**
 * SESSION-001/003 (Phase 1A, gap closure) — EVERY protected callable, executed.
 *
 * For each callable that acts as the signed-in account (money, calls, party,
 * Agora media tokens, partner/host applications, host capture, likes), the
 * SHIPPED handler is run against four account states and must refuse each one
 * at the server, before any work:
 *
 *   displaced         — presents a session id that is no longer the active one
 *   suspended         — `isSuspended` (the CRM also sets `isBanned`)
 *   banned            — `isBanned`
 *   deletion-pending  — `isDeleted` / `accountState: recovery_pending`
 *
 * And the control: a healthy account presenting its CURRENT session id —
 * including an anonymous GUEST — is NOT refused by the session gate (it may
 * still fail later for unrelated reasons such as a missing room, which is not
 * what this file is about).
 *
 * Exits — leaving a room or seat, ending a call, declining, cancelling a seat
 * request, ending one's own party room, signing out — are deliberately NOT
 * gated, so a displaced or restricted device can always let go of what it
 * holds. That list is pinned at the end.
 *
 * Run:  node --test test/sessionCoveragePhase1a.test.js
 */

const { test, describe, beforeEach } = require('node:test')
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
const TOKEN = { auth_time: 2000, phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } }
const GUEST_TOKEN = { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } }

// [label, invoke(data, token)] — v1 callables take (data, context); v2 take (request).
const v1 = (fn) => (data, token = TOKEN) => fn.run(data, { auth: { uid: UID, token } })
const v2 = (fn) => (data, token = TOKEN) => fn.run({ data, auth: { uid: UID, token } })

const GUARDED = [
  ['startCall', v2(calls.startCall), { peerUid: 'P' }],
  ['acceptCall', v2(calls.acceptCall), { callId: 'C' }],
  ['settleGift', v2(gifts.settleGift), { giftId: 'g', receiverUid: 'R' }],
  ['convertBeans', v1(wallet.convertBeans), { beansAmount: 10 }],
  ['claimDailyReward', v1(wallet.claimDailyReward), {}],
  // O8 (5 Nov 2026): a daily task's reward is money too.
  ['claimDailyTask', v1(index.claimDailyTask), { taskId: 'gift1' }],
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
  // UGP-C: a restricted account cannot use the email-code flow to send mail.
  ['requestEmailBindCode', v1(emailOtp.requestEmailBindCode), { email: 'x@example.test' }],
  ['verifyEmailBindCode', v1(emailOtp.verifyEmailBindCode), { email: 'x@example.test', code: '123456' }],
]

const STATES = {
  displaced: { doc: { activeMobileSession: { sessionId: 'SESSION-ON-OTHER-PHONE' } }, presented: CURRENT },
  suspended: { doc: { isSuspended: true, isBanned: true, accountState: 'suspended', activeMobileSession: { sessionId: CURRENT } }, presented: CURRENT },
  banned: { doc: { isBanned: true, accountState: 'banned', activeMobileSession: { sessionId: CURRENT } }, presented: CURRENT },
  'deletion-pending': { doc: { isDeleted: true, accountState: 'recovery_pending', activeMobileSession: { sessionId: CURRENT } }, presented: CURRENT },
}

async function outcome(p) {
  try { await p; return { ok: true } } catch (e) { return { ok: false, code: e.code, detail: e.details && e.details.code } }
}
const GATE_CODES = ['SESSION_DISPLACED', 'ACCOUNT_RESTRICTED']

describe('every protected callable refuses displaced / suspended / banned / deletion-pending', () => {
  beforeEach(() => { db._docs.clear(); delete process.env.ENFORCE_MOBILE_SESSION })
  for (const [name, invoke, data] of GUARDED) {
    for (const [state, { doc, presented }] of Object.entries(STATES)) {
      test(`${name} — ${state}`, async () => {
        db.seed(`users/${UID}`, { name: 'u', ...doc })
        const r = await outcome(invoke({ ...data, sessionId: presented }))
        expect(r.ok).toBe(false)
        expect(r.code).toBe('permission-denied')
        expect(GATE_CODES.includes(r.detail)).toBe(true)
      })
    }
    test(`${name} — a healthy account on its CURRENT session passes the gate`, async () => {
      db.seed(`users/${UID}`, { name: 'u', activeMobileSession: { sessionId: CURRENT } })
      const r = await outcome(invoke({ ...data, sessionId: CURRENT }))
      expect(GATE_CODES.includes(r.detail)).toBe(false)
    })
    test(`${name} — a GUEST on its current session is not refused by the gate`, async () => {
      db.seed(`users/${UID}`, { name: 'g', activeMobileSession: { sessionId: CURRENT } })
      const r = await outcome(invoke({ ...data, sessionId: CURRENT }, GUEST_TOKEN))
      expect(GATE_CODES.includes(r.detail)).toBe(false)
    })
  }
})

describe('staged rollout', () => {
  beforeEach(() => { db._docs.clear() })
  test('a client that sends no session id is tolerated while ENFORCE_MOBILE_SESSION is unset', async () => {
    delete process.env.ENFORCE_MOBILE_SESSION
    db.seed(`users/${UID}`, { name: 'u', activeMobileSession: { sessionId: CURRENT } })
    const r = await outcome(v1(party.joinPartyRoom)({ roomId: 'R' }))
    expect(GATE_CODES.includes(r.detail)).toBe(false)
  })
  test('…and refused once it is set', async () => {
    process.env.ENFORCE_MOBILE_SESSION = 'true'
    db.seed(`users/${UID}`, { name: 'u', activeMobileSession: { sessionId: CURRENT } })
    const r = await outcome(v1(party.joinPartyRoom)({ roomId: 'R' }))
    expect(r.detail).toBe('SESSION_DISPLACED')
    delete process.env.ENFORCE_MOBILE_SESSION
  })
  test('a restricted account is refused EVEN with no session id and enforcement off', async () => {
    delete process.env.ENFORCE_MOBILE_SESSION
    db.seed(`users/${UID}`, { isSuspended: true, isBanned: true })
    const r = await outcome(v1(index.generateAgoraToken)({ channelName: 'party_R' }))
    expect(r.detail).toBe('ACCOUNT_RESTRICTED')
  })
})

describe('exits stay ungated (a displaced or restricted device can always let go)', () => {
  const fs = require('fs')
  const src = (f) => fs.readFileSync(require('path').join(__dirname, '..', 'src', f), 'utf8')
  const body = (s, name) => {
    const i = s.indexOf(`export const ${name} `)
    const j = s.indexOf('\nexport const ', i + 10)
    return s.slice(i, j < 0 ? undefined : j)
  }
  for (const [file, name] of [
    ['party.ts', 'leavePartyRoom'], ['party.ts', 'leavePartySeat'], ['party.ts', 'cancelPartySeatRequest'],
    ['party.ts', 'endPartyRoom'], ['calls.ts', 'endCall'], ['calls.ts', 'declineCall'], ['calls.ts', 'tickCall'],
    ['identity.ts', 'endMobileSession'], ['accounts.ts', 'recoverAccount'], ['quickLogin.ts', 'submitAccountAppeal'],
  ]) {
    test(`${name} is not session-gated`, () => {
      expect(body(src(file), name).includes('assertActiveSession(')).toBe(false)
    })
  }
})

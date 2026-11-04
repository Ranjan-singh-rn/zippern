/**
 * B7 (3 Nov 2026) — private party rooms: Party Pro (the level-7, ₹200-a-month subscription), the per-person PIN
 * lockout, the room's access log, and official access. The SHIPPED callables over the in-memory Firestore.
 *
 *   * Party Pro: price = ₹ at the economy's diamond price (or the Owner's diamond price); level 7 to subscribe; the
 *     server takes the diamonds in the transaction that extends the entitlement (a ledger row, a payment row, a
 *     revenue row); a replayed request pays once; a second purchase extends from the current end, not from now;
 *     cancelling keeps access to the end; the daily pass renews from the wallet or records why it could not.
 *   * The gate: opening a private room, or making a room private, needs an unexpired Party Pro.
 *   * PIN lockout: five wrong PINs in fifteen minutes lock THAT person out of THAT room for fifteen minutes — even
 *     the right PIN is refused while locked; everybody else is unaffected; a right PIN clears the misses.
 *   * The access log: every admission, wrong PIN, lock-out and official entry, readable by the room owner.
 *   * Official access: the Owner (or staff with `privateRoomAccess`) enters without the PIN — logged, and shown.
 *
 * Run:  node --test test/partyPro.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({ getUser: async (uid) => ({ uid, providerData: [] }) }),
})

const PARTY = require('../lib/party')
const SUB = require('../lib/partySubscription')

const DAY = 86_400_000
const ctx = (uid) => ({ auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 60 } } })
const call = (fn, data, uid) => fn.run(data, ctx(uid))
async function refusal(p) { try { await p } catch (e) { return e } return null }
let k = 0
const key = () => `sub-key-${++k}-xxxx`

beforeEach(() => {
  db._docs.clear()
  db.seed('users/OWNER', { name: 'Owner', accountState: 'active', level: 8, diamonds: 20_000 })
  db.seed('users/LOW', { name: 'Low', accountState: 'active', level: 6, diamonds: 20_000 })
  for (const u of ['GUEST', 'OTHER', 'STAFF', 'PLAIN']) db.seed(`users/${u}`, { name: u, accountState: 'active', level: 1, diamonds: 0 })
  db.seed('appConfig/economy', { diamondPackPriceInr: 2390 })
})

const user = (uid) => db.read(`users/${uid}`)
const sub = (uid) => db.read(`partySubscriptions/${uid}`)

describe('Party Pro: the price, the gate and the purchase', () => {
  test('₹200 at ₹2390 a lakh is 8369 diamonds (rounded up); the Owner may set diamonds outright', () => {
    const cfg = SUB.mergeSubConfig(undefined)
    expect(cfg).toEqual({ enabled: true, required: true, priceInr: 200, priceDiamonds: 0, minLevel: 7, days: 30 })
    expect(SUB.priceInDiamonds(cfg, { diamondPackPriceInr: 2390 })).toBe(8369)
    expect(SUB.priceInDiamonds(cfg, { diamondPackPriceInr: 1000 })).toBe(20_000)
    expect(SUB.priceInDiamonds({ ...cfg, priceDiamonds: 5000 }, { diamondPackPriceInr: 2390 })).toBe(5000)
    expect(SUB.nextExpiry(0, 1000, 30)).toBe(1000 + 30 * DAY)
    expect(SUB.nextExpiry(5000 + 30 * DAY, 5000, 30)).toBe(5000 + 60 * DAY)
  })

  test('below level 7: refused, nothing moves', async () => {
    const e = await refusal(call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'LOW'))
    expect(e.details.code).toBe('LEVEL_TOO_LOW')
    expect(user('LOW').diamonds).toBe(20_000)
    expect(sub('LOW')).toBe(undefined)
  })

  test('the server takes the diamonds and extends the entitlement — once per request', async () => {
    const kk = key()
    const r = await call(SUB.subscribePrivateRooms, { idempotencyKey: kk }, 'OWNER')
    expect(r.priceDiamonds).toBe(8369)
    expect(user('OWNER').diamonds).toBe(20_000 - 8369)
    expect(Math.abs(sub('OWNER').expiresAtMs - (Date.now() + 30 * DAY)) < 5000).toBe(true)
    expect(db.read('users/OWNER/diamondTransactions/sub_OWNER_1')).toMatchObject({ type: 'debit', amount: 8369, reason: 'party_pro_subscription' })
    expect(db.read('subscriptionPayments/OWNER_1')).toMatchObject({ uid: 'OWNER', kind: 'new', diamonds: 8369, priceInr: 200 })
    expect(db.read('platformRevenue/sub_OWNER_1')).toMatchObject({ type: 'subscription', grossDiamonds: 8369, platformCut: 8369 })
    const again = await call(SUB.subscribePrivateRooms, { idempotencyKey: kk }, 'OWNER')
    expect(again.replayed).toBe(true)
    expect(user('OWNER').diamonds).toBe(20_000 - 8369)
    // A second purchase while active adds a period to the END, not to today.
    const first = sub('OWNER').expiresAtMs
    await call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'OWNER')
    expect(sub('OWNER').expiresAtMs).toBe(first + 30 * DAY)
    expect(db.read('subscriptionPayments/OWNER_2').kind).toBe('renewal')
  })

  test('not enough diamonds, or a restricted account: refused', async () => {
    db.seed('users/OWNER', { name: 'Owner', accountState: 'active', level: 8, diamonds: 100 })
    expect((await refusal(call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'OWNER'))).details.code).toBe('INSUFFICIENT_DIAMONDS')
    db.seed('users/OWNER', { name: 'Owner', accountState: 'suspended', level: 8, diamonds: 20_000 })
    const e = await refusal(call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'OWNER'))
    expect(e.code).toBe('permission-denied')
    expect(user('OWNER').diamonds).toBe(20_000)
  })

  test('the status the app shows', async () => {
    const s = await call(SUB.privateRoomSubscriptionStatus, {}, 'LOW')
    expect(s).toMatchObject({ enabled: true, minLevel: 7, level: 6, eligible: false, priceDiamonds: 8369, active: false })
  })
})

describe('the gate: private rooms are Party Pro', () => {
  test('no subscription: a private room is refused (with the level, or the offer to subscribe)', async () => {
    const low = await refusal(call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'LOW'))
    expect(low.details.code).toBe('PRIVATE_ROOM_SUBSCRIPTION_REQUIRED')
    expect(low.message).toContain('level 7')
    const owner = await refusal(call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'OWNER'))
    expect(owner.message).toContain('Subscribe')
    // A public room is free, as before.
    expect((await call(PARTY.createPartyRoom, { mode: 'audio' }, 'LOW')).roomId.length > 0).toBe(true)
  })

  test('subscribed: a private room opens; switching a public room to private is gated the same way', async () => {
    await call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'OWNER')
    const r = await call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'OWNER')
    expect(db.read(`partyRooms/${r.roomId}`).visibility).toBe('private')
    const pub = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'LOW')
    const e = await refusal(call(PARTY.updatePartyRoom, { roomId: pub.roomId, visibility: 'private', password: '1234' }, 'LOW'))
    expect(e.details.code).toBe('PRIVATE_ROOM_SUBSCRIPTION_REQUIRED')
  })

  test('cancelled: access lasts to the end; expired: refused again; the Owner can make it free', async () => {
    await call(SUB.subscribePrivateRooms, { idempotencyKey: key() }, 'OWNER')
    const c = await call(SUB.cancelPrivateRoomSubscription, {}, 'OWNER')
    expect(c.autoRenew).toBe(false)
    await call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'OWNER')
    db.seed('partySubscriptions/OWNER', { ...sub('OWNER'), expiresAtMs: Date.now() - 1000 })
    expect((await refusal(call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'OWNER'))).details.code)
      .toBe('PRIVATE_ROOM_SUBSCRIPTION_REQUIRED')
    db.seed('appConfig/partySubscription', { required: false })
    expect((await call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'LOW')).roomId.length > 0).toBe(true)
  })

  test('the daily pass renews from the wallet, or records why not; a cancelled one is left to end', async () => {
    const nowMs = Date.now()
    db.seed('partySubscriptions/OWNER', { uid: 'OWNER', expiresAtMs: nowMs + 3600_000, autoRenew: true, renewals: 1 })
    db.seed('partySubscriptions/LOW', { uid: 'LOW', expiresAtMs: nowMs + 3600_000, autoRenew: true, renewals: 1 })      // level 6 now
    db.seed('users/GUEST', { name: 'GUEST', accountState: 'active', level: 9, diamonds: 10 })
    db.seed('partySubscriptions/GUEST', { uid: 'GUEST', expiresAtMs: nowMs + 3600_000, autoRenew: true, renewals: 1 })  // too poor
    db.seed('partySubscriptions/OTHER', { uid: 'OTHER', expiresAtMs: nowMs + 3600_000, autoRenew: false, renewals: 1 }) // cancelled
    const r = await SUB.renewPrivateRoomSubscriptionsOnce(nowMs)
    expect(r).toEqual({ renewed: 1, failed: 2 })
    expect(sub('OWNER').expiresAtMs).toBe(nowMs + 3600_000 + 30 * DAY)
    expect(user('OWNER').diamonds).toBe(20_000 - 8369)
    expect(sub('LOW').renewalFailure).toBe('not_eligible')
    expect(sub('GUEST').renewalFailure).toBe('insufficient_diamonds')
    expect(user('GUEST').diamonds).toBe(10)
    expect(sub('OTHER').renewalFailedAtMs).toBe(undefined)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
async function privateRoom() {
  db.seed('partySubscriptions/OWNER', { uid: 'OWNER', expiresAtMs: Date.now() + 30 * DAY, autoRenew: true })
  return (await call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: '1234' }, 'OWNER')).roomId
}
const log = (roomId) => db.all(`partyRooms/${roomId}/accessLog`).sort((a, b) => a.atMs - b.atMs)

describe('the PIN: a lockout on the guesser, and an access log', () => {
  test('five wrong PINs lock that person out — even the right PIN waits; others are not affected', async () => {
    const id = await privateRoom()
    for (let i = 1; i <= 4; i++) {
      const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
      expect(e.code).toBe('permission-denied')
    }
    const fifth = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    expect(fifth.code).toBe('resource-exhausted')
    expect(fifth.details.code).toBe('PARTY_PIN_LOCKED')
    const right = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST'))
    expect(right.details.code).toBe('PARTY_PIN_LOCKED')
    expect(db.read(`partyRooms/${id}/listeners/GUEST`)).toBe(undefined)
    // Somebody else is not locked out by GUEST's guessing.
    expect((await call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'OTHER')).joined).toBe(true)
    const results = log(id).map((x) => `${x.uid}:${x.result}`)
    expect(results.filter((x) => x === 'GUEST:wrong_pin').length).toBe(5)
    expect(results.includes('GUEST:locked')).toBe(true)
    expect(results.includes('OTHER:admitted')).toBe(true)
  })

  test('when the lock has passed the right PIN admits, and the misses are cleared', async () => {
    const id = await privateRoom()
    for (let i = 0; i < 5; i++) await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    const m = db.read(`partyRooms/${id}/pinMisses/GUEST`)
    db.seed(`partyRooms/${id}/pinMisses/GUEST`, { ...m, lockedUntilMs: Date.now() - 1 })
    expect((await call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST')).joined).toBe(true)
    expect(db.read(`partyRooms/${id}/pinMisses/GUEST`)).toBe(undefined)
  })

  test('the window: misses older than fifteen minutes start a new count', () => {
    const t = 1_000_000
    let m = PARTY.nextPinMisses(undefined, t)
    for (let i = 0; i < 3; i++) m = PARTY.nextPinMisses(m, t + i)
    expect(m.count).toBe(4)
    expect(PARTY.nextPinMisses(m, t + PARTY.PIN_WINDOW_MS + 10).count).toBe(1)
    const locked = PARTY.nextPinMisses(m, t + 100)
    expect(PARTY.pinLockState(locked, t + 200).locked).toBe(true)
    expect(PARTY.pinLockState(locked, t + 100 + PARTY.PIN_LOCK_MS + 1).locked).toBe(false)
  })
})

describe('official access', () => {
  test('the Owner enters without the PIN — logged, flagged on the listener row and on the room', async () => {
    const id = await privateRoom()
    db.seed('crmUsers/STAFF', { role: 'superadmin', isActive: true })
    const r = await call(PARTY.joinPartyRoom, { roomId: id, official: true }, 'STAFF')
    expect(r.joined).toBe(true)
    expect(db.read(`partyRooms/${id}/listeners/STAFF`)).toMatchObject({ official: true, officialRole: 'superadmin' })
    expect(db.read(`partyRooms/${id}`).officialPresentUids).toEqual(['STAFF'])
    expect(log(id).find((x) => x.uid === 'STAFF')).toMatchObject({ result: 'official', role: 'superadmin' })
    // Leaving: no longer present; the visit stays in the log.
    await call(PARTY.leavePartyRoom, { roomId: id }, 'STAFF')
    expect(db.read(`partyRooms/${id}`).officialPresentUids).toEqual([])
    expect(log(id).some((x) => x.uid === 'STAFF' && x.result === 'official')).toBe(true)
  })
  test('staff without the grant, and an ordinary account, are refused — not quietly sent to the PIN', async () => {
    const id = await privateRoom()
    db.seed('crmUsers/STAFF', { role: 'support_admin', isActive: true })
    expect((await refusal(call(PARTY.joinPartyRoom, { roomId: id, official: true }, 'STAFF'))).code).toBe('permission-denied')
    db.seed('crmUsers/STAFF', { role: 'support_admin', isActive: true, privateRoomAccess: true })
    expect((await call(PARTY.joinPartyRoom, { roomId: id, official: true }, 'STAFF')).joined).toBe(true)
    expect((await refusal(call(PARTY.joinPartyRoom, { roomId: id, official: true }, 'PLAIN'))).code).toBe('permission-denied')
    db.seed('crmUsers/OTHER', { role: 'seller', isActive: true, privateRoomAccess: true })                   // a partner, not staff
    expect((await refusal(call(PARTY.joinPartyRoom, { roomId: id, official: true }, 'OTHER'))).code).toBe('permission-denied')
  })
})

describe('room themes and "no calls while I host"', () => {
  test('a theme from the list is kept; anything else is refused, and a new room starts classic', async () => {
    const r = await call(PARTY.createPartyRoom, { mode: 'audio', theme: 'galaxy-unknown' }, 'OWNER')
    expect(db.read(`partyRooms/${r.roomId}`).theme).toBe('classic')
    await call(PARTY.updatePartyRoom, { roomId: r.roomId, theme: 'ocean' }, 'OWNER')
    expect(db.read(`partyRooms/${r.roomId}`).theme).toBe('ocean')
    const e = await refusal(call(PARTY.updatePartyRoom, { roomId: r.roomId, theme: '<script>' }, 'OWNER'))
    expect(e.code).toBe('invalid-argument')
    expect(db.read(`partyRooms/${r.roomId}`).theme).toBe('ocean')
    expect((await refusal(call(PARTY.updatePartyRoom, { roomId: r.roomId, theme: 'rose' }, 'GUEST'))).code).toBe('permission-denied')
  })

  test('the host switches calls off: a caller is told they are hosting; switched back on, the call rings', async () => {
    const calls = require('../lib/calls')
    const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
    await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'OWNER')
    await call(PARTY.updatePartyRoom, { roomId: r.roomId, blockCalls: true }, 'OWNER')
    db.seed('users/OWNER', { ...user('OWNER'), isHost: true, isVerifiedHost: true, callRateBeans: 500, gender: 'female' })
    db.seed('users/GUEST', { ...user('GUEST'), diamonds: 5000, gender: 'male' })
    const start = (k2) => calls.startCall.run({ data: { peerUid: 'OWNER', idempotencyKey: k2 }, auth: { uid: 'GUEST', token: { auth_time: 2000, firebase: { sign_in_provider: 'phone' } } } })
    const e = await refusal(start('call-k1'))
    expect(e.details.code).toBe('PEER_IN_PARTY')
    expect(e.message).toContain('hosting a party room')
    await call(PARTY.updatePartyRoom, { roomId: r.roomId, blockCalls: false }, 'OWNER')
    const ok = await start('call-k2')
    expect(db.read(`calls/${ok.callId}`).status).toBe('ringing')
  })
})

describe('a gift in a party room flies from the sender to the receiver', () => {
  test('the room mirror names the receiver and the settlement, written with the gift', async () => {
    const gifts = require('../lib/gifts')
    const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
    await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'OWNER')
    await call(PARTY.takePartySeat, { roomId: r.roomId, seatIndex: 1 }, 'OWNER')
    db.seed('gifts/rose', { name: 'Rose', category: 'normal', diamondCost: 10, earningRate: 50, isActive: true })
    db.seed('users/GUEST', { ...user('GUEST'), diamonds: 100 })
    const res = await gifts.settleGift.run({
      data: { giftId: 'rose', receiverUid: 'OWNER', context: 'party', roomId: r.roomId, quantity: 1, idempotencyKey: 'gift-k-1' },
      auth: { uid: 'GUEST', token: { auth_time: 2000, firebase: { sign_in_provider: 'phone' } } },
    })
    const [mirror] = db.all(`partyRooms/${r.roomId}/gifts`)
    expect(mirror).toMatchObject({ uid: 'GUEST', receiverUid: 'OWNER', transactionId: res.transactionId, diamondCost: 10 })
  })

  test('O2: the room mirror carries the CRM\'s Lottie and SVGA, so the room can play the animation', async () => {
    const gifts = require('../lib/gifts')
    const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
    await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'OWNER')
    await call(PARTY.takePartySeat, { roomId: r.roomId, seatIndex: 1 }, 'OWNER')
    db.seed('gifts/castle', { name: 'Castle', category: 'normal', diamondCost: 10, earningRate: 50, isActive: true,
      lottieAsset: 'gifts/g10_castle.json', svgaUrl: '' })
    db.seed('users/GUEST', { ...user('GUEST'), diamonds: 100 })
    await gifts.settleGift.run({
      data: { giftId: 'castle', receiverUid: 'OWNER', context: 'party', roomId: r.roomId, quantity: 1, idempotencyKey: 'gift-k-lottie' },
      auth: { uid: 'GUEST', token: { auth_time: 2000, firebase: { sign_in_provider: 'phone' } } },
    })
    const [mirror] = db.all(`partyRooms/${r.roomId}/gifts`)
    expect(mirror).toMatchObject({ giftId: 'castle', lottieAsset: 'gifts/g10_castle.json', svgaUrl: '' })
  })
})

describe('room music: only Zipper\'s own catalogue, only the owner or an admin', () => {
  test('a catalogue track plays and is shown; anything else is refused; stopping clears it', async () => {
    const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
    db.seed('musicTracks/t1', { title: 'Evening Raga', artist: 'Zipper Studio', url: 'https://storage.example/t1.mp3', enabled: true })
    db.seed('musicTracks/off', { title: 'Old', url: 'https://storage.example/off.mp3', enabled: false })
    const ok = await call(PARTY.setPartyMusic, { roomId: r.roomId, trackId: 't1' }, 'OWNER')
    expect(ok).toEqual({ playing: true, title: 'Evening Raga' })
    expect(db.read(`partyRooms/${r.roomId}`).music).toMatchObject({ trackId: 't1', title: 'Evening Raga', by: 'OWNER', playing: true })
    expect((await refusal(call(PARTY.setPartyMusic, { roomId: r.roomId, trackId: 'off' }, 'OWNER'))).code).toBe('not-found')
    expect((await refusal(call(PARTY.setPartyMusic, { roomId: r.roomId, trackId: 'nope' }, 'OWNER'))).code).toBe('not-found')
    expect((await refusal(call(PARTY.setPartyMusic, { roomId: r.roomId, trackId: 't1' }, 'GUEST'))).code).toBe('permission-denied')
    await call(PARTY.setPartyMusic, { roomId: r.roomId, trackId: null }, 'OWNER')
    expect(db.read(`partyRooms/${r.roomId}`).music).toBe(undefined)
  })
})

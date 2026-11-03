/**
 * B12 (4 Nov 2026) — live streaming, the server's half: executed against the in-memory Firestore (lib/).
 *
 *   * the viewer count is recounted from presence rows (and the peak kept), not trusted from phones;
 *   * the sweep closes rooms nobody closed (host silent, paused too long, pre-heartbeat builds), prunes stale
 *     presence, and ends PKs past their time — on both rooms, with the result recorded;
 *   * PK matching / accepting / ending is done by the server on BOTH rooms (one phone cannot write the other's);
 *   * PK scores come from settleGift, in the gift's own transaction, from diamonds that moved;
 *   * a live gift is refused — nothing moved — for an ended room, a receiver who is not on screen, a sender the
 *     host removed or blocked;
 *   * a viewer the host blocked gets no token;
 *   * streamed time is measured by the server, not taken from the host's app.
 *
 * Run:  node --test test/b12Live.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [] }),
    revokeRefreshTokens: async () => undefined,
  }),
})
process.env.AGORA_APP_ID = 'a'.repeat(32)
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32)

const L = require('../lib/live')
const gifts = require('../lib/gifts')
const profiles = require('../lib/profiles')
const index = require('../lib/index')

const token = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
const ctx = (uid) => ({ auth: { uid, token } })
const NOW = Date.now()
const ago = (ms) => Timestamp.fromMillis(Date.now() - ms)

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

function host(uid, extra = {}) {
  db.seed(`users/${uid}`, { name: `Host ${uid}`, isHost: true, isVerifiedHost: true, beans: 0, ...extra })
}
function room(id, hostUid, extra = {}) {
  db.seed(`liveRooms/${id}`, {
    hostUid, hostName: `Host ${hostUid}`, hostPhotoUrl: '', isActive: true, viewerCount: 0,
    totalGiftsReceived: 0, totalBeansEarned: 0, startedAt: Timestamp.now(), hostHeartbeatAt: Timestamp.now(), ...extra,
  })
}

beforeEach(() => { db._docs.clear() })

describe('pure decisions', () => {
  test('a room is closed when its host goes silent, a pause runs too long, or a pre-heartbeat room is old', () => {
    expect(L.staleLiveRoom({ isActive: true, hostHeartbeatAt: NOW - 60_000 }, NOW)).toBe(null)
    expect(L.staleLiveRoom({ isActive: true, hostHeartbeatAt: NOW - 4 * 60_000 }, NOW)).toBe('host_lost')
    expect(L.staleLiveRoom({ isActive: true, isPaused: true, pausedAt: NOW - 16 * 60_000, hostHeartbeatAt: NOW }, NOW)).toBe('paused_too_long')
    expect(L.staleLiveRoom({ isActive: true, isPaused: true, pausedAt: NOW - 60_000, hostHeartbeatAt: NOW }, NOW)).toBe(null)
    expect(L.staleLiveRoom({ isActive: true, startedAt: NOW - 60 * 60_000 }, NOW)).toBe(null)
    expect(L.staleLiveRoom({ isActive: true, startedAt: NOW - 13 * 60 * 60_000 }, NOW)).toBe('legacy_stale')
    expect(L.staleLiveRoom({ isActive: false, hostHeartbeatAt: 0 }, NOW)).toBe(null)
  })

  test('presence rows: refreshed ones stay, silent ones go, pre-refresh ones get six hours', () => {
    expect(L.viewerIsStale({ lastSeenAt: NOW - 60_000 }, NOW)).toBe(false)
    expect(L.viewerIsStale({ lastSeenAt: NOW - 4 * 60_000 }, NOW)).toBe(true)
    expect(L.viewerIsStale({ joinedAt: NOW - 60 * 60_000 }, NOW)).toBe(false)
    expect(L.viewerIsStale({ joinedAt: NOW - 7 * 60 * 60_000 }, NOW)).toBe(true)
  })

  test('the server\'s duration: from its own start mark; else the app\'s figure capped at the room\'s age', () => {
    expect(L.serverDurationSeconds({ serverStartedAt: NOW - 600_000, durationSeconds: 999_999 }, NOW)).toBe(600)
    expect(L.serverDurationSeconds({ startedAt: NOW - 600_000, durationSeconds: 999_999 }, NOW)).toBe(600)
    expect(L.serverDurationSeconds({ startedAt: NOW - 600_000, durationSeconds: 120 }, NOW)).toBe(120)
    expect(L.serverDurationSeconds({ durationSeconds: 120 }, NOW)).toBe(0)
  })

  test('a live gift: on air, to the host (or the PK opponent), not from somebody removed or blocked', () => {
    const r = { isActive: true, hostUid: 'H1', kickedViewers: ['K'] }
    expect(L.liveGiftRefusal({ room: r, senderUid: 'V', receiverUid: 'H1', senderBlockedByHost: false })).toBe(null)
    expect(L.liveGiftRefusal({ room: { ...r, isActive: false }, senderUid: 'V', receiverUid: 'H1', senderBlockedByHost: false })).toBe('This live has ended.')
    expect(L.liveGiftRefusal({ room: r, senderUid: 'V', receiverUid: 'X', senderBlockedByHost: false })).toBe('Gifts here go to the host.')
    expect(L.liveGiftRefusal({ room: { ...r, pkActive: true, pkPartnerUid: 'H2' }, senderUid: 'V', receiverUid: 'H2', senderBlockedByHost: false })).toBe(null)
    expect(L.liveGiftRefusal({ room: r, senderUid: 'K', receiverUid: 'H1', senderBlockedByHost: false })).toBe('You were removed from this live by the host.')
    expect(L.liveGiftRefusal({ room: r, senderUid: 'V', receiverUid: 'H1', senderBlockedByHost: true })).toBe('You can\'t send gifts in this live.')
  })

  test('PK: the higher score wins; equal is a draw; scores count only before the end', () => {
    expect(L.pkWinner(10, 5)).toBe('A')
    expect(L.pkWinner(5, 10)).toBe('B')
    expect(L.pkWinner(7, 7)).toBe('draw')
    expect(L.pkScoring({ pkActive: true, pkEndTime: NOW + 1000 }, NOW)).toBe(true)
    expect(L.pkScoring({ pkActive: true, pkEndTime: NOW - 1 }, NOW)).toBe(false)
  })
})

describe('who is watching — recounted on the server', () => {
  const event = (exists0, exists1) => ({ before: { exists: exists0 }, after: { exists: exists1 } })

  test('a join and a leave recount from the presence rows; the peak stays', async () => {
    room('R1', 'H1', { viewerCount: 999 })
    for (const v of ['A', 'B', 'C']) db.seed(`liveRooms/R1/viewers/${v}`, { uid: v, lastSeenAt: Timestamp.now() })
    await L.liveViewerCount.run(event(false, true), { params: { roomId: 'R1', uid: 'C' } })
    expect(db.read('liveRooms/R1').viewerCount).toBe(3)
    expect(db.read('liveRooms/R1').peakViewers).toBe(3)
    await db.collection('liveRooms').doc('R1').collection('viewers').doc('C').delete()
    await L.liveViewerCount.run(event(true, false), { params: { roomId: 'R1', uid: 'C' } })
    expect(db.read('liveRooms/R1').viewerCount).toBe(2)
    expect(db.read('liveRooms/R1').peakViewers).toBe(3)
  })

  test('a heartbeat on an existing row is not a change in who is watching', async () => {
    room('R1', 'H1', { viewerCount: 7 })
    await L.liveViewerCount.run(event(true, true), { params: { roomId: 'R1', uid: 'A' } })
    expect(db.read('liveRooms/R1').viewerCount).toBe(7)
  })
})

describe('the sweep', () => {
  test('closes a room whose host went silent, and clears its presence rows; a healthy room is untouched', async () => {
    room('DEAD', 'H1', { hostHeartbeatAt: ago(5 * 60_000) })
    db.seed('liveRooms/DEAD/viewers/V1', { uid: 'V1', lastSeenAt: Timestamp.now() })
    room('OK', 'H2')
    db.seed('liveRooms/OK/viewers/V2', { uid: 'V2', lastSeenAt: Timestamp.now() })
    db.seed('liveRooms/OK/viewers/GONE', { uid: 'GONE', lastSeenAt: ago(10 * 60_000) })
    const r = await L.sweepLiveRoomsOnce()
    expect(r.closed).toBe(1)
    expect(db.read('liveRooms/DEAD').isActive).toBe(false)
    expect(db.read('liveRooms/DEAD').endReason).toBe('host_lost')
    expect(db.has('liveRooms/DEAD/viewers/V1')).toBe(false)
    expect(db.read('liveRooms/OK').isActive).toBe(true)
    expect(db.has('liveRooms/OK/viewers/V2')).toBe(true)
    expect(db.has('liveRooms/OK/viewers/GONE')).toBe(false)
  })

  test('a pause past fifteen minutes ends the live', async () => {
    room('P', 'H1', { isPaused: true, pausedAt: ago(20 * 60_000) })
    await L.sweepLiveRoomsOnce()
    expect(db.read('liveRooms/P').isActive).toBe(false)
    expect(db.read('liveRooms/P').endReason).toBe('paused_too_long')
  })

  test('a PK past its time is ended on both rooms with the result', async () => {
    room('A', 'HA', { pkActive: true, pkPartnerId: 'B', pkPartnerUid: 'HB', pkScore: 300, pkPartnerScore: 100, pkEndTime: NOW - 60_000, pkInviteId: 'I1' })
    room('B', 'HB', { pkActive: true, pkPartnerId: 'A', pkPartnerUid: 'HA', pkScore: 100, pkPartnerScore: 300, pkEndTime: NOW - 60_000, pkInviteId: 'I1' })
    db.seed('pkInvites/I1', { hostARoomId: 'A', hostBRoomId: 'B', hostAUid: 'HA', hostBUid: 'HB', participants: ['HA', 'HB'], status: 'started' })
    const r = await L.sweepLiveRoomsOnce()
    expect(r.pkEnded).toBe(1)
    expect(db.read('liveRooms/A').pkActive).toBe(false)
    expect(db.read('liveRooms/B').pkActive).toBe(false)
    expect(db.read('liveRooms/A').lastPk.winnerUid).toBe('HA')
    expect(db.read('liveRooms/B').lastPk).toEqual({ winnerUid: 'HA', myScore: 100, partnerScore: 300, reason: 'time', endedAtMs: db.read('liveRooms/B').lastPk.endedAtMs })
    expect(db.read('pkInvites/I1').status).toBe('ended')
    expect(db.read('pkInvites/I1').result.hostAScore).toBe(300)
  })
})

describe('PK battles — written by the server on both rooms', () => {
  beforeEach(() => { host('HA'); host('HB'); room('A', 'HA'); room('B', 'HB') })

  test('the first host waits; the second is matched; both get one invite', async () => {
    expect(await L.pkMatch.run({ roomId: 'A' }, ctx('HA'))).toEqual({ queued: true, inviteId: '' })
    expect(db.read('liveRooms/A').pkWaiting).toBe(true)
    const m = await L.pkMatch.run({ roomId: 'B' }, ctx('HB'))
    expect(m.queued).toBe(false)
    const inv = db.read(`pkInvites/${m.inviteId}`)
    expect(inv.participants.sort()).toEqual(['HA', 'HB'])
    expect(inv.status).toBe('pending')
    expect(db.read('liveRooms/A').pkWaiting).toBe(false)
    expect(db.read('liveRooms/B').pkWaiting).toBe(false)
  })

  test('only the room\'s own host may queue it', async () => {
    const e = await refusal(L.pkMatch.run({ roomId: 'A' }, ctx('HB')))
    expect(e && e.code).toBe('permission-denied')
  })

  test('both must accept; the second acceptance starts the PK on both rooms with the server\'s end time', async () => {
    await L.pkMatch.run({ roomId: 'A' }, ctx('HA'))
    const { inviteId } = await L.pkMatch.run({ roomId: 'B' }, ctx('HB'))
    expect((await L.pkRespond.run({ inviteId, accept: true }, ctx('HA'))).status).toBe('waiting')
    expect(db.read('liveRooms/A').pkActive === true).toBe(false)
    const started = await L.pkRespond.run({ inviteId, accept: true }, ctx('HB'))
    expect(started.status).toBe('started')
    const a = db.read('liveRooms/A')
    const b = db.read('liveRooms/B')
    expect(a.pkActive).toBe(true)
    expect(b.pkActive).toBe(true)
    expect(a.pkPartnerUid).toBe('HB')
    expect(b.pkPartnerUid).toBe('HA')
    expect(a.pkChannelId).toBe(b.pkChannelId)
    expect(Math.abs(a.pkEndTime - (Date.now() + L.PK_DURATION_MS)) < 5000).toBe(true)
  })

  test('a decline, a stranger, and a room that ended meanwhile', async () => {
    await L.pkMatch.run({ roomId: 'A' }, ctx('HA'))
    const { inviteId } = await L.pkMatch.run({ roomId: 'B' }, ctx('HB'))
    host('X')
    expect((await refusal(L.pkRespond.run({ inviteId, accept: true }, ctx('X')))).code).toBe('permission-denied')
    await L.pkRespond.run({ inviteId, accept: true }, ctx('HA'))
    db.seed('liveRooms/B', { ...db.read('liveRooms/B'), isActive: false })
    expect((await L.pkRespond.run({ inviteId, accept: true }, ctx('HB'))).status).toBe('cancelled')
    expect(db.read('liveRooms/A').pkActive === true).toBe(false)
  })

  test('pkEnd by a host: the result on both rooms and the invite; a non-host is refused', async () => {
    await L.pkMatch.run({ roomId: 'A' }, ctx('HA'))
    const { inviteId } = await L.pkMatch.run({ roomId: 'B' }, ctx('HB'))
    await L.pkRespond.run({ inviteId, accept: true }, ctx('HA'))
    await L.pkRespond.run({ inviteId, accept: true }, ctx('HB'))
    expect((await refusal(L.pkEnd.run({ roomId: 'A' }, ctx('HB')))).code).toBe('permission-denied')
    expect(await L.pkEnd.run({ roomId: 'A' }, ctx('HA'))).toEqual({ ended: true })
    expect(db.read('liveRooms/A').lastPk.reason).toBe('host_ended')
    expect(db.read('liveRooms/A').lastPk.winnerUid).toBe('')
    expect(db.read(`pkInvites/${inviteId}`).status).toBe('ended')
  })
})

describe('live gifts — settled with the PK score, refused when they do not belong', () => {
  const CROWN = { name: 'Crown', emoji: '👑', category: 'normal', diamondCost: 100, earningRate: 50, isActive: true }
  const send = (uid, data) => gifts.settleGift.run({ data: { context: 'live', quantity: 1, giftId: 'crown', ...data }, auth: { uid, token } })
  beforeEach(() => {
    db.seed('gifts/crown', CROWN)
    db.seed('users/V', { name: 'Viewer', diamonds: 1000 })
    host('HA'); host('HB')
    room('A', 'HA', { pkActive: true, pkPartnerId: 'B', pkPartnerUid: 'HB', pkScore: 0, pkPartnerScore: 0, pkEndTime: Date.now() + 60_000 })
    room('B', 'HB', { pkActive: true, pkPartnerId: 'A', pkPartnerUid: 'HA', pkScore: 0, pkPartnerScore: 0, pkEndTime: Date.now() + 60_000 })
  })

  test('to this room\'s host during a PK: this room scores, the other room sees it as the partner\'s score', async () => {
    await send('V', { roomId: 'A', receiverUid: 'HA', idempotencyKey: 'g1' })
    expect(db.read('users/V').diamonds).toBe(900)
    expect(db.read('liveRooms/A').pkScore).toBe(100)
    expect(db.read('liveRooms/B').pkPartnerScore).toBe(100)
    expect(db.read('liveRooms/B').pkScore).toBe(0)
  })

  test('to the battling host from this room: THEIR room scores', async () => {
    await send('V', { roomId: 'A', receiverUid: 'HB', idempotencyKey: 'g2' })
    expect(db.read('liveRooms/B').pkScore).toBe(100)
    expect(db.read('liveRooms/A').pkPartnerScore).toBe(100)
    expect(db.read('liveRooms/A').pkScore).toBe(0)
  })

  test('after the PK\'s end time, a gift scores nothing', async () => {
    db.seed('liveRooms/A', { ...db.read('liveRooms/A'), pkEndTime: Date.now() - 1 })
    await send('V', { roomId: 'A', receiverUid: 'HA', idempotencyKey: 'g3' })
    expect(db.read('liveRooms/A').pkScore).toBe(0)
  })

  test('refused with nothing moved: ended room, receiver not on screen, removed sender, blocked sender', async () => {
    db.seed('liveRooms/C', { hostUid: 'HC', isActive: false })
    host('HC')
    host('X')
    expect((await refusal(send('V', { roomId: 'C', receiverUid: 'HC', idempotencyKey: 'r1' }))).message).toBe('This live has ended.')
    db.seed('liveRooms/D', { hostUid: 'HC', isActive: true })
    expect((await refusal(send('V', { roomId: 'D', receiverUid: 'X', idempotencyKey: 'r2' }))).message).toBe('Gifts here go to the host.')
    db.seed('liveRooms/D', { hostUid: 'HC', isActive: true, kickedViewers: ['V'] })
    expect((await refusal(send('V', { roomId: 'D', receiverUid: 'HC', idempotencyKey: 'r3' }))).message).toBe('You were removed from this live by the host.')
    db.seed('liveRooms/D', { hostUid: 'HC', isActive: true })
    db.seed('users/HC/blocked/V', { blockedAt: 1 })
    expect((await refusal(send('V', { roomId: 'D', receiverUid: 'HC', idempotencyKey: 'r4' }))).message).toBe('You can\'t send gifts in this live.')
    expect(db.read('users/V').diamonds).toBe(1000)
    expect(db.read('users/HC').beans).toBe(0)
  })
})

describe('a viewer the host blocked gets no token', () => {
  test('refused; an unblocked viewer still watches', async () => {
    host('H2')
    db.seed('users/V1', { name: 'V1' })
    db.seed('users/V2', { name: 'V2' })
    room('LIVE2', 'H2')
    db.seed('users/H2/blocked/V1', { blockedAt: 1 })
    const e = await refusal(index.generateAgoraToken.run({ channelName: 'LIVE2', uid: 0 }, ctx('V1')))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toBe('You can\'t watch this live.')
    const ok = await index.generateAgoraToken.run({ channelName: 'LIVE2', uid: 0 }, ctx('V2'))
    expect(ok.role).toBe('subscriber')
  })
})

describe('streamed time — measured by the server', () => {
  test('going live stamps the start; closing measures from it and ignores the app\'s figure', async () => {
    host('H1', { streamedTimeSeconds: 0 })
    db.seed('publicProfiles/H1', { name: 'H1' })
    const ref = db.collection('liveRooms').doc('R')
    db.seed('liveRooms/R', { hostUid: 'H1', isActive: true })
    await profiles.syncLivePresence.run(
      { before: { exists: false, data: () => undefined }, after: { exists: true, data: () => db.read('liveRooms/R'), ref } },
      { params: { roomId: 'R' } },
    )
    expect(db.read('liveRooms/R').serverStartedAt != null).toBe(true)
    // Pretend ten minutes passed, and the app claims a day.
    const started = { ...db.read('liveRooms/R'), serverStartedAt: Timestamp.fromMillis(Date.now() - 600_000) }
    db.seed('liveRooms/R', { ...started, isActive: false, durationSeconds: 86_400 })
    await profiles.syncLivePresence.run(
      { before: { exists: true, data: () => started }, after: { exists: true, data: () => db.read('liveRooms/R'), ref } },
      { params: { roomId: 'R' } },
    )
    const secs = db.read('liveRooms/R').serverDurationSeconds
    expect(secs >= 599 && secs <= 601).toBe(true)
    expect(db.read('users/H1').streamedTimeSeconds).toBe(secs)
  })
})

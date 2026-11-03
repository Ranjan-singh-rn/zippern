/**
 * B2a (3 Nov 2026) — a party room is NOT empty while people are in its lobby.
 *
 * The defect: the empty-room clock (`emptySince`) started when the last SEAT emptied, every client still watching
 * called `endPartyRoom` two seconds later, and the sweep closed any room with no seated occupant — so a room full of
 * listeners was shut on them. Now:
 *
 *   * a room is empty only when nobody is on a seat AND nobody is in the lobby (`roomIsEmpty`);
 *   * a listener proves presence with `partyHeartbeat`; the sweep removes one that has been quiet for 3 minutes
 *     (6 hours for a row from before heartbeats), freeing any seat they held, so a dead phone cannot keep a room open;
 *   * a private room remembers who it let in (`admitted/{uid}`), so coming back after such a removal does not ask
 *     for the PIN again — and a stranger still cannot get in without it.
 *
 * REAL: `lib/party.js` as deployed, over the in-memory Firestore in optimistic-transaction mode.
 *
 * Run:  node --test test/partyLobby.test.js
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
const { Timestamp } = admin.firestore

const ctx = (uid) => ({ auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 60 } } })
const call = (fn, data, uid) => fn.run(data, ctx(uid))
async function refusal(p) { try { await p } catch (e) { return e } return null }
const room = (id) => db.read(`partyRooms/${id}`)
const listener = (id, uid) => db.read(`partyRooms/${id}/listeners/${uid}`)
const ago = (ms) => Timestamp.fromMillis(Date.now() - ms)

beforeEach(() => {
  db._docs.clear()
  for (const uid of ['OWNER', 'GUEST', 'OTHER', 'THIRD']) {
    db.seed(`users/${uid}`, { name: uid, accountState: 'active', photoUrl: '' })
  }  // B7: a private room is Party Pro — the owner holds an unexpired subscription (partySubscription.test.js tests the gate).
  db.seed('partySubscriptions/OWNER', { uid: 'OWNER', expiresAtMs: Date.now() + 30 * 86_400_000, autoRenew: true })
})

async function openRoom({ visibility = 'public', pin } = {}) {
  const made = await call(PARTY.createPartyRoom, {
    title: 'Lobby test', mode: 'audio', seatCount: 10, seatMode: 'free', visibility,
    ...(pin ? { password: pin } : {}),
  }, 'OWNER')
  await call(PARTY.joinPartyRoom, { roomId: made.roomId }, 'OWNER')
  return made.roomId
}

describe('the rule: seats alone never make a room empty', () => {
  test('roomIsEmpty needs no one seated AND no one listening', () => {
    expect(PARTY.roomIsEmpty(0, 0)).toBe(true)
    expect(PARTY.roomIsEmpty(0, 1)).toBe(false)   // the bug: this used to close the room
    expect(PARTY.roomIsEmpty(1, 0)).toBe(false)
    expect(PARTY.roomIsEmpty(-1, -1)).toBe(true)  // a drifted count below zero is still nobody
  })

  test('listenerIsStale: 3 minutes after the last heartbeat; 6 hours after joining for a row with no heartbeat', () => {
    const now = Date.now()
    expect(PARTY.listenerIsStale({ lastSeenAt: Timestamp.fromMillis(now - 60_000) }, now)).toBe(false)
    expect(PARTY.listenerIsStale({ lastSeenAt: Timestamp.fromMillis(now - PARTY.LISTENER_STALE_MS) }, now)).toBe(true)
    expect(PARTY.listenerIsStale({ joinedAt: Timestamp.fromMillis(now - 60 * 60 * 1000) }, now)).toBe(false)
    expect(PARTY.listenerIsStale({ joinedAt: Timestamp.fromMillis(now - PARTY.LEGACY_LISTENER_STALE_MS) }, now)).toBe(true)
    expect(PARTY.listenerIsStale({}, now)).toBe(true)
    // A fresh heartbeat wins over an old join.
    expect(PARTY.listenerIsStale({ joinedAt: Timestamp.fromMillis(now - 10 * 60 * 60 * 1000),
      lastSeenAt: Timestamp.fromMillis(now - 1000) }, now)).toBe(false)
  })
})

describe('a room with people in the lobby stays open', () => {
  test('the last seat emptying does not start the empty clock while a listener is in the room', async () => {
    const id = await openRoom()
    await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    await call(PARTY.takePartySeat, { roomId: id, seatIndex: 1 }, 'OWNER')
    expect(room(id).occupantCount).toBe(1)
    await call(PARTY.leavePartySeat, { roomId: id }, 'OWNER')
    expect(room(id).occupantCount).toBe(0)
    expect(room(id).listenerCount).toBe(2)
    expect(room(id).emptySince ?? null).toBe(null)
  })

  test('…so a listener cannot close it, and the sweep leaves it open even long after it opened', async () => {
    const id = await openRoom()
    await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    const e = await refusal(call(PARTY.endPartyRoom, { roomId: id }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
    // An hour-old room with nobody ever seated, two people in the lobby, both heartbeating.
    db.seed(`partyRooms/${id}`, { ...room(id), startedAt: ago(60 * 60 * 1000) })
    const swept = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(swept.closed).toBe(0)
    expect(room(id).isActive).toBe(true)
  })

  test('when the last person leaves, the room is empty, and then it closes', async () => {
    const id = await openRoom()
    await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    await call(PARTY.leavePartyRoom, { roomId: id }, 'GUEST')
    expect(room(id).emptySince ?? null).toBe(null)          // the owner is still there
    await call(PARTY.leavePartyRoom, { roomId: id }, 'OWNER')
    expect(room(id).listenerCount).toBe(0)
    expect(room(id).emptySince != null).toBe(true)
    // Past the grace: anybody may close it, and the sweep does.
    db.seed(`partyRooms/${id}`, { ...room(id), emptySince: ago(10_000) })
    const swept = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(swept.closed).toBe(1)
    expect(room(id).isActive).toBe(false)
  })

  test('walking back in stops the clock', async () => {
    const id = await openRoom()
    await call(PARTY.leavePartyRoom, { roomId: id }, 'OWNER')
    expect(room(id).emptySince != null).toBe(true)
    await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    expect(room(id).emptySince ?? null).toBe(null)
  })

  test('a never-occupied room nobody is in is still closed after ten minutes', async () => {
    const made = await call(PARTY.createPartyRoom, { title: 'x', mode: 'audio', seatCount: 10 }, 'OWNER')
    db.seed(`partyRooms/${made.roomId}`, { ...room(made.roomId), startedAt: ago(PARTY.NEVER_OCCUPIED_GRACE_MS + 1000) })
    const swept = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(swept.closed).toBe(1)
  })
})

describe('people who left without leaving', () => {
  test('a quiet listener is removed, their seat freed and their presence cleared; the room then closes', async () => {
    const id = await openRoom()
    await call(PARTY.takePartySeat, { roomId: id, seatIndex: 2 }, 'OWNER')
    // The owner's phone died four minutes ago.
    db.seed(`partyRooms/${id}/listeners/OWNER`, { ...listener(id, 'OWNER'), lastSeenAt: ago(4 * 60 * 1000) })
    const first = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(first.pruned).toBe(1)
    expect(listener(id, 'OWNER')).toBe(undefined)
    expect(room(id).occupantCount).toBe(0)
    expect(room(id).listenerCount).toBe(0)
    expect(db.read('users/OWNER').isInParty).toBe(false)
    // Nobody left: the clock started now, so the NEXT sweep after the grace closes it.
    db.seed(`partyRooms/${id}`, { ...room(id), emptySince: ago(10_000) })
    const second = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(second.closed).toBe(1)
  })

  test('a listener who is heartbeating is kept; presence elsewhere is not cleared', async () => {
    const id = await openRoom()
    await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    db.seed(`partyRooms/${id}/listeners/GUEST`, { ...listener(id, 'GUEST'), lastSeenAt: ago(5 * 60 * 1000) })
    db.seed('users/GUEST', { ...db.read('users/GUEST'), isInParty: true, partyRoomId: 'ANOTHER_ROOM' })
    const r = await call(PARTY.partyHeartbeat, { roomId: id }, 'OWNER')
    expect(r.present).toBe(true)
    const swept = await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(swept.pruned).toBe(1)                                  // GUEST, quiet for 5 minutes
    expect(listener(id, 'OWNER') != null).toBe(true)              // OWNER, heartbeating
    expect(db.read('users/GUEST').partyRoomId).toBe('ANOTHER_ROOM')
    expect(room(id).isActive).toBe(true)
  })

  test('a row from before heartbeats is kept for six hours after joining, then removed', async () => {
    const id = await openRoom()
    db.seed(`partyRooms/${id}/listeners/OTHER`, { uid: 'OTHER', joinedAt: ago(60 * 60 * 1000) })
    db.seed(`partyRooms/${id}`, { ...room(id), listenerCount: 2 })
    expect((await PARTY.sweepPartyRoomsOnce(Date.now())).pruned).toBe(0)
    db.seed(`partyRooms/${id}/listeners/OTHER`, { uid: 'OTHER', joinedAt: ago(PARTY.LEGACY_LISTENER_STALE_MS + 1000) })
    expect((await PARTY.sweepPartyRoomsOnce(Date.now())).pruned).toBe(1)
    expect(room(id).listenerCount).toBe(1)
  })
})

describe('partyHeartbeat', () => {
  test('refreshes the caller\'s own row and nothing else', async () => {
    const id = await openRoom()
    db.seed(`partyRooms/${id}/listeners/OWNER`, { ...listener(id, 'OWNER'), lastSeenAt: ago(120_000) })
    const before = room(id)
    const r = await call(PARTY.partyHeartbeat, { roomId: id }, 'OWNER')
    expect(r).toEqual({ active: true, present: true, nextInMs: PARTY.PARTY_HEARTBEAT_EVERY_MS })
    expect(Date.now() - listener(id, 'OWNER').lastSeenAt.toMillis() < 5_000).toBe(true)
    expect(room(id)).toEqual(before)
  })

  test('present: false once the row is gone; active: false once the room is closed', async () => {
    const id = await openRoom()
    expect(await call(PARTY.partyHeartbeat, { roomId: id }, 'GUEST')).toEqual({ active: true, present: false })
    await call(PARTY.endPartyRoom, { roomId: id }, 'OWNER')
    expect(await call(PARTY.partyHeartbeat, { roomId: id }, 'OWNER')).toEqual({ active: false, present: false })
  })

  test('refuses a caller with no account and a missing room id', async () => {
    expect((await refusal(PARTY.partyHeartbeat.run({ roomId: 'R' }, {}))).code).toBe('unauthenticated')
    expect((await refusal(call(PARTY.partyHeartbeat, {}, 'OWNER'))).code).toBe('invalid-argument')
  })
})

describe('a private room remembers who it let in', () => {
  test('back after a removal: no PIN; a stranger: still needs it', async () => {
    const id = await openRoom({ visibility: 'private', pin: '4321' })
    await call(PARTY.joinPartyRoom, { roomId: id, password: '4321' }, 'GUEST')
    expect(db.read(`partyRooms/${id}/admitted/GUEST`).via).toBe('pin')
    // GUEST's phone slept; the sweep took the row.
    db.seed(`partyRooms/${id}/listeners/GUEST`, { ...listener(id, 'GUEST'), lastSeenAt: ago(10 * 60 * 1000) })
    await PARTY.sweepPartyRoomsOnce(Date.now())
    expect(listener(id, 'GUEST')).toBe(undefined)
    // Comes back: let in without the PIN.
    const back = await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')
    expect(back.joined).toBe(true)
    // Somebody who never gave the PIN is still refused.
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id }, 'THIRD'))
    expect(e && e.code).toBe('permission-denied')
    expect(db.read(`partyRooms/${id}/admitted/THIRD`)).toBe(undefined)
  })

  test('a wrong PIN admits nobody and remembers nothing', async () => {
    const id = await openRoom({ visibility: 'private', pin: '4321' })
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    expect(e != null).toBe(true)
    expect(db.read(`partyRooms/${id}/admitted/GUEST`)).toBe(undefined)
    expect(listener(id, 'GUEST')).toBe(undefined)
  })
})

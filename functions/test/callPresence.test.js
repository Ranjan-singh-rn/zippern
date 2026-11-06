/**
 * WP2 (Owner, 5 Nov 2026) — "all call buttons depend on the call on or off [of] that person": BUSY.
 *
 * `users/{uid}.isInCall` had no writer, so a host already on a call was rung by everybody else. syncCallPresence keeps
 * it from the call documents: a person is in a call exactly while one of their calls is `connected` or `ending`, and
 * the value is written only when it changes. Executed against the in-memory Firestore (lib/).
 *
 * Run:  node --test test/callPresence.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const P = require('../lib/callPresence')
const index = require('../lib/index')

beforeEach(() => { db._docs.clear() })

/** The trigger, as Firestore would call it for a write that took the call from [before] to [after]. */
async function write(callId, before, after) {
  if (after) db.seed(`calls/${callId}`, after)
  else db._docs.delete(`calls/${callId}`)
  const side = (d) => ({ exists: !!d, data: () => d })
  await index.syncCallPresence.run({ before: side(before), after: side(after) }, { params: { callId } })
}

const call = (status, extra = {}) => ({ callerId: 'U1', receiverId: 'H1', status, ...extra })

describe('pure decisions', () => {
  test('live means connected or ending — never ringing, ended, declined or missed', () => {
    for (const s of ['connected', 'ending']) expect(P.isLiveCallStatus(s)).toBe(true)
    for (const s of ['ringing', 'ended', 'declined', 'missed', undefined, null, 3]) expect(P.isLiveCallStatus(s)).toBe(false)
  })

  test('only a write that changes whether the call is live matters', () => {
    expect(P.presenceChanged(call('ringing'), call('connected'))).toBe(true)
    expect(P.presenceChanged(call('connected'), call('ending'))).toBe(false)
    expect(P.presenceChanged(call('ending'), call('ended'))).toBe(true)
    expect(P.presenceChanged(undefined, call('ringing'))).toBe(false)
    expect(P.presenceChanged(call('connected', { tickIndex: 1 }), call('connected', { tickIndex: 2 }))).toBe(false)
  })
})

describe('syncCallPresence', () => {
  test('picked up: both people are in a call; hung up: both are free again', async () => {
    db.seed('users/U1', { uid: 'U1', isInCall: false })
    db.seed('users/H1', { uid: 'H1' })
    await write('C1', undefined, call('ringing'))
    expect(db.read('users/U1').isInCall).toBe(false)
    expect(db.read('users/H1').isInCall).toBe(undefined)   // a ringing phone is not a call yet: nothing written

    await write('C1', call('ringing'), call('connected'))
    expect(db.read('users/U1').isInCall).toBe(true)
    expect(db.read('users/H1').isInCall).toBe(true)

    await write('C1', call('connected'), call('ending'))     // the last minute settling: still on the call
    expect(db.read('users/H1').isInCall).toBe(true)

    await write('C1', call('ending'), call('ended'))
    expect(db.read('users/U1').isInCall).toBe(false)
    expect(db.read('users/H1').isInCall).toBe(false)
  })

  test('a host on a second live call stays busy when the first one ends', async () => {
    db.seed('users/U1', { uid: 'U1' })
    db.seed('users/U2', { uid: 'U2' })
    db.seed('users/H1', { uid: 'H1' })
    await write('C1', call('ringing'), call('connected'))
    await write('C2', { callerId: 'U2', receiverId: 'H1', status: 'ringing' }, { callerId: 'U2', receiverId: 'H1', status: 'connected' })
    await write('C1', call('connected'), call('ended'))
    expect(db.read('users/U1').isInCall).toBe(false)
    expect(db.read('users/H1').isInCall).toBe(true)
    expect(db.read('users/U2').isInCall).toBe(true)
  })

  test('declined and missed calls never make anybody busy; a stale flag is put right on the next change', async () => {
    db.seed('users/U1', { uid: 'U1', isInCall: true })      // left over from before this function existed
    db.seed('users/H1', { uid: 'H1', isInCall: false })
    await write('C3', call('ringing'), call('declined'))
    expect(db.read('users/U1').isInCall).toBe(true)          // nothing live changed: no write at all
    await write('C4', call('ringing'), call('connected'))
    await write('C4', call('connected'), call('ended'))
    expect(db.read('users/U1').isInCall).toBe(false)
  })

  test('the call document removed while live frees both people; an account that is gone is skipped', async () => {
    db.seed('users/U1', { uid: 'U1' })
    await write('C5', call('ringing'), call('connected'))
    expect(db.read('users/U1').isInCall).toBe(true)
    await write('C5', call('connected'), undefined)
    expect(db.read('users/U1').isInCall).toBe(false)
    expect(db.read('users/H1')).toBe(undefined)
  })
})

describe('Owner 6 Nov: viewers see the call (live overlay, party seat icon, yellow listener dot)', () => {
  test('a live host on a call marks their live room; the call ending clears it', async () => {
    db.seed('users/U1', { uid: 'U1' })
    db.seed('users/H1', { uid: 'H1' })
    db.seed('liveRooms/L1', { hostUid: 'H1', isActive: true })
    db.seed('liveRooms/OLD', { hostUid: 'H1', isActive: false })
    await write('C7', call('ringing'), call('connected'))
    expect(db.read('liveRooms/L1').hostInCall).toBe(true)
    expect(db.read('liveRooms/OLD').hostInCall).toBe(undefined)
    await write('C7', call('connected'), call('ended'))
    expect(db.read('liveRooms/L1').hostInCall).toBe(false)
  })

  test('a party member on a call: their seat and their listener row say so', async () => {
    db.seed('users/U1', { uid: 'U1', partyRoomId: 'P1' })
    db.seed('users/H1', { uid: 'H1' })
    db.seed('partyRooms/P1', { hostUid: 'X' })
    db.seed('partyRooms/P1/listeners/U1', { uid: 'U1' })
    db.seed('partyRooms/P1/seats/2', { uid: 'U1' })
    db.seed('partyRooms/P1/seats/3', { uid: 'Z9' })
    await write('C8', call('ringing'), call('connected'))
    expect(db.read('partyRooms/P1/listeners/U1').inCall).toBe(true)
    expect(db.read('partyRooms/P1/seats/2').inCall).toBe(true)
    expect(db.read('partyRooms/P1/seats/3').inCall).toBe(undefined)
    await write('C8', call('connected'), call('ended'))
    expect(db.read('partyRooms/P1/listeners/U1').inCall).toBe(false)
  })
})

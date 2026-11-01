/**
 * F-7 (audit 2026-11-01) — the private-room PIN is no longer on the room
 * document any signed-in client can read.
 *
 *   * `createPartyRoom` / `updatePartyRoom` write `passwordHash` and
 *     `passwordSalt` to `partyRooms/{id}/private/secret` and NEVER to the room
 *     document; the room keeps only `visibility` and `passwordAttempts`;
 *   * `joinPartyRoom` verifies against the secret document, server-side;
 *   * a wrong PIN is counted (the old in-transaction increment was rolled back
 *     with the throw, so the counter never moved) and admits nobody;
 *   * a room opened by the previous build (hash still on the room document) is
 *     honoured and migrated on the first successful join;
 *   * closing a room deletes its secret.
 *
 * The fake Firestore runs in OPTIMISTIC mode so a transaction that throws
 * discards its writes, exactly as the SDK does.
 *
 * Run:  node --test test/partyPin.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const crypto = require('node:crypto')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore({ transactions: 'optimistic' })
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({ getUser: async (uid) => ({ uid, providerData: [] }) }),
})

const PARTY = require('../lib/party')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 60 } } })
const call = (fn, data, uid) => fn.run(data, ctx(uid))
async function refusal(p) { try { await p } catch (e) { return e } return null }

const legacyHash = (salt, pin) => crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex')
const secretOf = (roomId) => db.read(`partyRooms/${roomId}/private/secret`)
const room = (roomId) => db.read(`partyRooms/${roomId}`)

beforeEach(() => {
  db._docs.clear()
  for (const uid of ['OWNER', 'GUEST', 'OTHER']) {
    db.seed(`users/${uid}`, { name: uid, accountState: 'active', photoUrl: '' })
  }
})

async function privateRoom(pin = '1234') {
  const r = await call(PARTY.createPartyRoom, { mode: 'audio', visibility: 'private', password: pin }, 'OWNER')
  return r.roomId
}

describe('F-7 — where the secret lives', () => {
  test('a private room is created with its hash in private/secret and nothing secret on the room document', async () => {
    const id = await privateRoom('4321')
    const doc = room(id)
    expect(doc.visibility).toBe('private')
    expect(doc.passwordAttempts).toBe(0)
    expect(doc.passwordHash).toBeUndefined()
    expect(doc.passwordSalt).toBeUndefined()
    const secret = secretOf(id)
    expect(typeof secret.passwordHash).toBe('string')
    expect(secret.passwordHash).toHaveLength(64)
    expect(secret.passwordSalt).toHaveLength(32)
    expect(secret.passwordHash).toBe(legacyHash(secret.passwordSalt, '4321'))
  })

  test('a public room writes no secret document at all', async () => {
    const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
    expect(secretOf(r.roomId)).toBeUndefined()
    expect(room(r.roomId).passwordHash).toBeUndefined()
  })

  test('a PIN that is not four digits is refused before anything is written', async () => {
    const before = db.writes
    for (const bad of ['123', '12345', 'abcd', '', undefined]) {
      const e = await refusal(call(PARTY.createPartyRoom, { visibility: 'private', password: bad }, 'OWNER'))
      expect(e && e.code).toBe('invalid-argument')
    }
    expect(db.writes).toBe(before)
    expect(db.count('partyRooms')).toBe(0)
  })

  test('the secret path constants are the documented ones (no rule matches them: deny-all applies)', () => {
    expect(PARTY.PRIVATE_SUBCOLLECTION).toBe('private')
    expect(PARTY.PRIVATE_SECRET_DOC).toBe('secret')
  })
})

describe('F-7 — joinPartyRoom verifies server-side', () => {
  test('the right PIN admits a member; the listener row and the count are written', async () => {
    const id = await privateRoom('1234')
    const r = await call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST')
    expect(r.joined).toBe(true)
    expect(r.role).toBe('member')
    expect(db.has(`partyRooms/${id}/listeners/GUEST`)).toBe(true)
    expect(room(id).listenerCount).toBe(1)
    expect(room(id).passwordAttempts).toBe(0)
  })

  test('a wrong PIN is refused, admits nobody, and IS counted', async () => {
    const id = await privateRoom('1234')
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toContain('not right')
    expect(db.has(`partyRooms/${id}/listeners/GUEST`)).toBe(false)
    expect(room(id).listenerCount).toBe(0)
    expect(room(id).passwordAttempts).toBe(1)
    await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '9999' }, 'OTHER'))
    expect(room(id).passwordAttempts).toBe(2)
    // Still no secret on the room document after all that.
    expect(room(id).passwordHash).toBeUndefined()
  })

  test('no PIN at all is a different refusal and is not counted as a guess', async () => {
    const id = await privateRoom('1234')
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
    expect(e.message).toContain('needs a password')
    expect(room(id).passwordAttempts).toBe(0)
  })

  test('the owner, and a listener already inside, need no PIN', async () => {
    const id = await privateRoom('1234')
    const owner = await call(PARTY.joinPartyRoom, { roomId: id }, 'OWNER')
    expect(owner.joined).toBe(true)
    expect(owner.role).toBe('owner')
    await call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST')
    const again = await call(PARTY.joinPartyRoom, { roomId: id }, 'GUEST')   // process restart, no re-typing
    expect(again.joined).toBe(true)
    expect(room(id).listenerCount).toBe(2)
  })

  test('a private room whose secret is missing admits no member (a lock with no key, not an open door)', async () => {
    const id = await privateRoom('1234')
    await db.collection('partyRooms').doc(id).collection('private').doc('secret').delete()
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
  })
})

describe('F-7 — updatePartyRoom keeps the secret off the room document', () => {
  test('changing the PIN rewrites private/secret, resets the counter, and leaves no hash on the room', async () => {
    const id = await privateRoom('1234')
    await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    const before = secretOf(id)
    const r = await call(PARTY.updatePartyRoom, { roomId: id, password: '5678' }, 'OWNER')
    expect(r.updated).toBe(true)
    const after = secretOf(id)
    expect(after.passwordHash).not.toBe(before.passwordHash)
    expect(after.passwordHash).toBe(legacyHash(after.passwordSalt, '5678'))
    expect(room(id).passwordAttempts).toBe(0)
    expect(room(id).passwordHash).toBeUndefined()
    // The new PIN works, the old one does not.
    expect((await refusal(call(PARTY.joinPartyRoom, { roomId: id, password: '1234' }, 'GUEST'))).code).toBe('permission-denied')
    expect((await call(PARTY.joinPartyRoom, { roomId: id, password: '5678' }, 'GUEST')).joined).toBe(true)
  })

  test('going public deletes the secret; going private again needs a PIN unless one is still on file', async () => {
    const id = await privateRoom('1234')
    await call(PARTY.updatePartyRoom, { roomId: id, visibility: 'public' }, 'OWNER')
    expect(secretOf(id)).toBeUndefined()
    expect(room(id).visibility).toBe('public')
    const e = await refusal(call(PARTY.updatePartyRoom, { roomId: id, visibility: 'private' }, 'OWNER'))
    expect(e && e.code).toBe('invalid-argument')
    expect(room(id).visibility).toBe('public')

    await call(PARTY.updatePartyRoom, { roomId: id, visibility: 'private', password: '2468' }, 'OWNER')
    expect(secretOf(id).passwordHash).toBe(legacyHash(secretOf(id).passwordSalt, '2468'))
    // A later visibility toggle without a PIN keeps the one on file.
    await call(PARTY.updatePartyRoom, { roomId: id, visibility: 'public' }, 'OWNER')
    await call(PARTY.updatePartyRoom, { roomId: id, visibility: 'private', password: '1357' }, 'OWNER')
    const r = await call(PARTY.updatePartyRoom, { roomId: id, visibility: 'private' }, 'OWNER')
    expect(r.updated).toBe(true)
    expect((await call(PARTY.joinPartyRoom, { roomId: id, password: '1357' }, 'GUEST')).joined).toBe(true)
  })

  test('only the owner may touch the PIN', async () => {
    const id = await privateRoom('1234')
    const e = await refusal(call(PARTY.updatePartyRoom, { roomId: id, password: '0000' }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
    expect(secretOf(id).passwordHash).toBe(legacyHash(secretOf(id).passwordSalt, '1234'))
  })
})

describe('F-7 — rooms opened by the previous build (migration)', () => {
  function legacyRoom(id, pin) {
    const passwordSalt = 'abcd'.repeat(8)
    db.seed(`partyRooms/${id}`, {
      hostUid: 'OWNER', mode: 'audio', isActive: true, visibility: 'private', seatCount: 10,
      seatMode: 'free', passwordSalt, passwordHash: legacyHash(passwordSalt, pin), passwordAttempts: 0,
      admins: [], lockedSeats: [], kickedUsers: [], listenerCount: 0, occupantCount: 0,
    })
  }

  test('the legacy hash is honoured, then moved into private/secret and deleted from the room document', async () => {
    legacyRoom('L1', '1234')
    const r = await call(PARTY.joinPartyRoom, { roomId: 'L1', password: '1234' }, 'GUEST')
    expect(r.joined).toBe(true)
    const secret = secretOf('L1')
    expect(secret.passwordHash).toBe(legacyHash('abcd'.repeat(8), '1234'))
    expect(secret.migratedAt).toBeTruthy()
    expect(room('L1').passwordHash).toBeUndefined()
    expect(room('L1').passwordSalt).toBeUndefined()
    expect(room('L1').listenerCount).toBe(1)
    // The next member verifies against the secret document.
    expect((await call(PARTY.joinPartyRoom, { roomId: 'L1', password: '1234' }, 'OTHER')).joined).toBe(true)
  })

  test('a wrong PIN on a legacy room is refused, counted, and migrates nothing', async () => {
    legacyRoom('L2', '1234')
    const e = await refusal(call(PARTY.joinPartyRoom, { roomId: 'L2', password: '4321' }, 'GUEST'))
    expect(e && e.code).toBe('permission-denied')
    expect(secretOf('L2')).toBeUndefined()
    expect(room('L2').passwordHash).toBe(legacyHash('abcd'.repeat(8), '1234'))
    expect(room('L2').passwordAttempts).toBe(1)
  })

  test("the owner's PIN edit on a legacy room moves the secret too", async () => {
    legacyRoom('L3', '1234')
    await call(PARTY.updatePartyRoom, { roomId: 'L3', password: '7777' }, 'OWNER')
    expect(room('L3').passwordHash).toBeUndefined()
    expect(room('L3').passwordSalt).toBeUndefined()
    expect(secretOf('L3').passwordHash).toBe(legacyHash(secretOf('L3').passwordSalt, '7777'))
  })

  test('a legacy room can be toggled private again without a new PIN (the legacy hash counts as "on file")', async () => {
    legacyRoom('L4', '1234')
    const r = await call(PARTY.updatePartyRoom, { roomId: 'L4', visibility: 'private' }, 'OWNER')
    expect(r.updated).toBe(true)
  })
})

describe('F-7 — a closed room holds no secret', () => {
  test('endPartyRoom deletes private/secret', async () => {
    const id = await privateRoom('1234')
    expect(secretOf(id)).toBeTruthy()
    const r = await call(PARTY.endPartyRoom, { roomId: id }, 'OWNER')
    expect(r.ended).toBe(true)
    expect(room(id).isActive).toBe(false)
    expect(secretOf(id)).toBeUndefined()
  })
})

describe('passwordMatches — pure', () => {
  test('matches only the hash of the given PIN under the stored salt', () => {
    const salt = 'ff'.repeat(16)
    const secret = { passwordHash: legacyHash(salt, '1234'), passwordSalt: salt }
    expect(PARTY.passwordMatches('1234', secret)).toBe(true)
    expect(PARTY.passwordMatches('1235', secret)).toBe(false)
    expect(PARTY.passwordMatches('', secret)).toBe(false)
    expect(PARTY.passwordMatches('1234', null)).toBe(false)
    expect(PARTY.passwordMatches('1234', {})).toBe(false)
    expect(PARTY.passwordMatches('1234', { passwordHash: 'abc', passwordSalt: salt })).toBe(false)
  })
})

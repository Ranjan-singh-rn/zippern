/**
 * O14 (Owner, 5 Nov 2026) — party music from the player's own phone.
 *
 *   "party music is not to add licensed tracks, but to access from your device if some audios are there grab them to
 *    play, like a music player."
 *
 * The SHIPPED `setPartyMusic`, `leavePartySeat` and `leavePartyRoom` over the in-memory Firestore:
 *
 *   * a device song is only its NAME on the room document — trimmed to one line, title ≤ 80, artist ≤ 60, through the
 *     O13 word screen (built-in list + the Owner's own words), no URL;
 *   * only the owner or an admin, and only from a seat (the audio goes out with their microphone);
 *   * pause keeps the name (shown as paused); another moderator starting a song takes over; stop clears it;
 *   * the player standing up, being removed from the seat or the room, or leaving the room stops it — somebody
 *     else's song is left alone;
 *   * Zipper's catalogue (`musicTracks`) still plays.
 *
 * Run:  node --test test/partyMusic.test.js
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
const SAFETY = require('../lib/safety')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) - 60 } } })
const call = (fn, data, uid) => fn.run(data, ctx(uid))
async function refusal(p) { try { await p } catch (e) { return e } return null }

beforeEach(() => {
  db._docs.clear()
  SAFETY._resetSafetyCache()
  for (const u of ['OWNER', 'ADMIN', 'GUEST', 'OTHER']) {
    db.seed(`users/${u}`, { name: u, accountState: 'active', level: 8, diamonds: 0 })
  }
})

const room = (id) => db.read(`partyRooms/${id}`)

/** An audio room with OWNER on seat 1 and ADMIN (made an admin) on seat 2; GUEST listening. */
async function roomWithSeats() {
  const r = await call(PARTY.createPartyRoom, { mode: 'audio' }, 'OWNER')
  await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'OWNER')
  await call(PARTY.takePartySeat, { roomId: r.roomId, seatIndex: 1 }, 'OWNER')
  await call(PARTY.setPartyAdmin, { roomId: r.roomId, targetUid: 'ADMIN', isAdmin: true }, 'OWNER')
  await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'ADMIN')
  await call(PARTY.takePartySeat, { roomId: r.roomId, seatIndex: 2 }, 'ADMIN')
  await call(PARTY.joinPartyRoom, { roomId: r.roomId }, 'GUEST')
  return r.roomId
}

const song = (roomId, extra = {}) => ({ roomId, source: 'device', title: 'Tum Hi Ho', artist: 'Arijit Singh', durationMs: 262_000, ...extra })

describe('deviceTrackOf — what the room shows of a song on somebody\'s phone (pure)', () => {
  const words = SAFETY.wordListOf(SAFETY.SAFETY_DEFAULTS)

  test('trimmed to one line, control and invisible characters gone', () => {
    expect(PARTY.deviceTrackOf({ title: '  Kesariya \n (Brahmastra)\t', artist: '​Pritam  ', durationMs: 268_000.4 }, words))
      .toEqual({ title: 'Kesariya (Brahmastra)', artist: 'Pritam', durationMs: 268_000 })
  })

  test('title capped at 80, artist at 60', () => {
    const t = PARTY.deviceTrackOf({ title: 'a'.repeat(200), artist: 'b'.repeat(200) }, words)
    expect(t.title.length).toBe(PARTY.MUSIC_TITLE_MAX)
    expect(t.artist.length).toBe(PARTY.MUSIC_ARTIST_MAX)
    expect(PARTY.MUSIC_TITLE_MAX).toBe(80)
    expect(PARTY.MUSIC_ARTIST_MAX).toBe(60)
  })

  test('no title → "Music"; not a string → treated as missing', () => {
    expect(PARTY.deviceTrackOf({ title: '   ' }, words).title).toBe('Music')
    expect(PARTY.deviceTrackOf({ title: { evil: 1 }, artist: 42 }, words)).toEqual({ title: 'Music', artist: '', durationMs: 0 })
  })

  test('abuse in a song name is masked, as in chat', () => {
    const t = PARTY.deviceTrackOf({ title: 'send nudes remix', artist: 'DJ fuck' }, words)
    expect(t.title.includes('nudes')).toBe(false)
    expect(t.title.includes('remix')).toBe(true)
    expect(t.artist.includes('fuck')).toBe(false)
    expect(t.artist.startsWith('DJ ')).toBe(true)
  })

  test('duration: whole milliseconds, 0 when missing, negative or past six hours', () => {
    expect(PARTY.deviceTrackOf({ title: 'x', durationMs: -5 }, words).durationMs).toBe(0)
    expect(PARTY.deviceTrackOf({ title: 'x', durationMs: 'abc' }, words).durationMs).toBe(0)
    expect(PARTY.deviceTrackOf({ title: 'x', durationMs: PARTY.MUSIC_DURATION_MAX_MS + 1 }, words).durationMs).toBe(0)
    expect(PARTY.deviceTrackOf({ title: 'x', durationMs: 1000 }, words).durationMs).toBe(1000)
  })

  test('musicPlayedBy: only a music map whose player is that person', () => {
    expect(PARTY.musicPlayedBy({ by: 'A' }, 'A')).toBe(true)
    expect(PARTY.musicPlayedBy({ by: 'A' }, 'B')).toBe(false)
    expect(PARTY.musicPlayedBy(undefined, 'A')).toBe(false)
    expect(PARTY.musicPlayedBy('A', 'A')).toBe(false)
    expect(PARTY.musicPlayedBy({ by: '' }, '')).toBe(false)
  })
})

describe('setPartyMusic — a song from the player\'s phone', () => {
  test('a seated owner plays a song: the room shows its name, no URL, the owner as player', async () => {
    const id = await roomWithSeats()
    const r = await call(PARTY.setPartyMusic, song(id), 'OWNER')
    expect(r).toEqual({ playing: true, title: 'Tum Hi Ho', artist: 'Arijit Singh' })
    expect(room(id).music).toMatchObject({
      source: 'device', trackId: '', title: 'Tum Hi Ho', artist: 'Arijit Singh', url: '', durationMs: 262_000,
      playing: true, by: 'OWNER',
    })
  })

  test('not on a seat: refused with the reason, nothing written', async () => {
    const id = await roomWithSeats()
    await call(PARTY.leavePartySeat, { roomId: id }, 'OWNER')
    const e = await refusal(call(PARTY.setPartyMusic, song(id), 'OWNER'))
    expect(e.code).toBe('failed-precondition')
    expect(e.details.code).toBe('MUSIC_NEEDS_SEAT')
    expect(room(id).music).toBe(undefined)
  })

  test('a listener who is not a moderator: refused', async () => {
    const id = await roomWithSeats()
    expect((await refusal(call(PARTY.setPartyMusic, song(id), 'GUEST'))).code).toBe('permission-denied')
    expect(room(id).music).toBe(undefined)
  })

  test('the Owner\'s own words (App Config → Safety) are screened too', async () => {
    db.seed('appConfig/safety', { badWords: ['ganda'] })
    SAFETY._resetSafetyCache()
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id, { title: 'ganda gaana' }), 'OWNER')
    expect(room(id).music.title.includes('ganda')).toBe(false)
    expect(room(id).music.title.includes('gaana')).toBe(true)
  })

  test('pause keeps the name; resume plays; another moderator taking over becomes the player; stop clears', async () => {
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id), 'OWNER')
    await call(PARTY.setPartyMusic, song(id, { playing: false }), 'OWNER')
    expect(room(id).music).toMatchObject({ title: 'Tum Hi Ho', playing: false, by: 'OWNER' })
    await call(PARTY.setPartyMusic, song(id, { playing: true }), 'OWNER')
    expect(room(id).music.playing).toBe(true)
    await call(PARTY.setPartyMusic, song(id, { title: 'Apna Bana Le', artist: 'Sachin-Jigar' }), 'ADMIN')
    expect(room(id).music).toMatchObject({ title: 'Apna Bana Le', by: 'ADMIN', playing: true })
    await call(PARTY.setPartyMusic, { roomId: id, trackId: null }, 'OWNER')
    expect(room(id).music).toBe(undefined)
  })

  test('a closed room: refused', async () => {
    const id = await roomWithSeats()
    await call(PARTY.endPartyRoom, { roomId: id }, 'OWNER')
    expect((await refusal(call(PARTY.setPartyMusic, song(id), 'OWNER'))).code).toBe('not-found')
  })
})

describe('the player leaving takes the song with them', () => {
  test('standing up stops the player\'s song', async () => {
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id), 'ADMIN')
    await call(PARTY.leavePartySeat, { roomId: id }, 'ADMIN')
    expect(room(id).music).toBe(undefined)
  })

  test('somebody else standing up leaves it alone', async () => {
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id), 'ADMIN')
    await call(PARTY.leavePartySeat, { roomId: id }, 'OWNER')
    expect(room(id).music).toMatchObject({ by: 'ADMIN', playing: true })
  })

  test('the owner removing the player from the seat, or from the room, stops it', async () => {
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id), 'ADMIN')
    await call(PARTY.leavePartySeat, { roomId: id, targetUid: 'ADMIN' }, 'OWNER')
    expect(room(id).music).toBe(undefined)

    const id2 = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id2), 'ADMIN')
    await call(PARTY.leavePartySeat, { roomId: id2, targetUid: 'ADMIN', kick: true }, 'OWNER')
    expect(room(id2).music).toBe(undefined)
  })

  test('leaving the room stops it; a listener leaving does not', async () => {
    const id = await roomWithSeats()
    await call(PARTY.setPartyMusic, song(id), 'ADMIN')
    await call(PARTY.leavePartyRoom, { roomId: id }, 'GUEST')
    expect(room(id).music).toMatchObject({ by: 'ADMIN' })
    await call(PARTY.leavePartyRoom, { roomId: id }, 'ADMIN')
    expect(room(id).music).toBe(undefined)
  })
})

describe('Zipper\'s catalogue still plays', () => {
  test('a catalogue track is named by id and shown with source "catalogue"', async () => {
    const id = await roomWithSeats()
    db.seed('musicTracks/t1', { title: 'Evening Raga', artist: 'Zipper Studio', url: 'https://storage.example/t1.mp3', enabled: true })
    expect(await call(PARTY.setPartyMusic, { roomId: id, trackId: 't1' }, 'OWNER')).toEqual({ playing: true, title: 'Evening Raga' })
    expect(room(id).music).toMatchObject({ source: 'catalogue', trackId: 't1', url: 'https://storage.example/t1.mp3', by: 'OWNER' })
  })
})

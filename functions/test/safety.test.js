/**
 * O13 (Owner, 5 Nov 2026) — "nudity, sexualism, vulgarities … I don't want my application like that. Keep the people
 * who spread these things away." Executed against the in-memory Firestore (lib/), Storage and Vision stubbed.
 *
 *   * the config: safe defaults, the AI check OFF until the Owner turns it on, every number clamped;
 *   * the word screen: whole words, spaced-out letters, leetspeak, repeated letters, Hindi — and no false alarms on
 *     ordinary words; the mask;
 *   * SafeSearch's verdict lines; a still's path must be the broadcaster's own room;
 *   * reportLiveSnapshot: the newest still kept and the one before deleted; with the check on, a flag (and an end only
 *     when the Owner also asked for one); a Vision failure recorded, not fatal; only the broadcaster may report;
 *   * the chat triggers: masked in place, strikes counted, silenced after the Owner's count — live (`mutedViewers`),
 *     party (`chatMutedUsers`) — and a flag for staff; a DM masked only.
 *
 * Run:  node --test test/safety.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const files = new Map()   // Storage objects that exist: path -> true
const deleted = []
Object.defineProperty(admin, 'storage', {
  configurable: true, writable: true,
  value: () => ({
    bucket: () => ({
      name: 'demo-bucket',
      file: (p) => ({
        exists: async () => [files.has(p)],
        delete: async () => { deleted.push(p); files.delete(p) },
      }),
    }),
  }),
})

const S = require('../lib/safety')
const index = require('../lib/index')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000, firebase: { sign_in_provider: 'phone' } } } })
async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}
const words = S.wordListOf(S.SAFETY_DEFAULTS)

beforeEach(() => {
  db._docs.clear()
  files.clear()
  deleted.length = 0
  S._resetSafetyCache()
  S.vision.safeSearch = async () => { throw new Error('Vision should not be called') }
})

describe('configuration', () => {
  test('defaults: the AI check and automatic ending OFF, a still a minute, three strikes in an hour', () => {
    expect(S.sanitizeSafetyConfig(null)).toEqual(S.SAFETY_DEFAULTS)
    expect(S.SAFETY_DEFAULTS.visionEnabled).toBe(false)
    expect(S.SAFETY_DEFAULTS.autoEndOnAdult).toBe(false)
  })
  test('every number is clamped, the switches are exactly true, words are trimmed and bounded', () => {
    const c = S.sanitizeSafetyConfig({ visionEnabled: 'yes', autoEndOnAdult: true, snapshotEverySeconds: 5,
      muteAfterStrikes: 0, strikeWindowMinutes: 999999, badWords: ['  Scam ', 'x', 42, 'ok word'] })
    expect(c.visionEnabled).toBe(false)
    expect(c.autoEndOnAdult).toBe(true)
    expect(c.snapshotEverySeconds).toBe(30)
    expect(c.muteAfterStrikes).toBe(1)
    expect(c.strikeWindowMinutes).toBe(1440)
    expect(c.badWords).toEqual(['scam', '42', 'ok word'])
  })
})

describe('the word screen', () => {
  const hits = (t) => S.findBadWords(t, words)
  test('catches whole words, leetspeak, repeated and spaced-out letters, squeezed long words, Hindi', () => {
    expect(hits('you are a b!tch')).toEqual(['bitch'])
    expect(hits('F U C K off')).toEqual(['fuck'])
    expect(hits('fuuuuck')).toEqual(['fuck'])
    expect(hits('send nudes')).toEqual(['nudes'])
    expect(hits('b.h.o.s.d.i.k.e').includes('bhosdike')).toBe(true)   // and its shorter stem, also listed
    expect(hits('ye chutiya hai')).toEqual(['chutiya'])
    expect(hits('तू चूतिया है')).toEqual(['चूतिया'])
    expect(hits('sh0w b00bs')).toEqual(['boobs'])
  })
  test('does not alarm on ordinary words', () => {
    for (const ok of ['class assessment', 'Charles Dickens', 'Sussex', 'grandiose plans', 'chutney', 'cockpit view',
      'hello everyone', 'nice song didi', 'good night']) {
      expect([ok, hits(ok)]).toEqual([ok, []])
    }
  })
  test('the Owner\'s own words count, and the built-in list can be switched off', () => {
    const own = S.wordListOf(S.sanitizeSafetyConfig({ badWords: ['scamlink'], useBuiltInWords: false }))
    expect(S.findBadWords('visit scamlink now', own)).toEqual(['scamlink'])
    expect(S.findBadWords('fuck', own)).toEqual([])
  })
  test('the mask hides the word and keeps the rest; spaced-out letters hide the whole message', () => {
    expect(S.maskText('you are a b!tch ok', ['bitch'])).toBe('you are a ***** ok')
    expect(S.maskText('F U C K', ['fuck'])).toBe('*******')
    expect(S.maskText('all good', [])).toBe('all good')
  })
})

describe('pure decisions', () => {
  test('SafeSearch: adult from LIKELY, racy and violence only at VERY_LIKELY', () => {
    expect(S.safeSearchVerdict({ adult: 'LIKELY' })).toEqual({ flag: true, level: 'adult' })
    expect(S.safeSearchVerdict({ adult: 'POSSIBLE', racy: 'LIKELY' })).toEqual({ flag: false, level: null })
    expect(S.safeSearchVerdict({ racy: 'VERY_LIKELY' })).toEqual({ flag: true, level: 'racy' })
    expect(S.safeSearchVerdict({ violence: 'VERY_LIKELY' })).toEqual({ flag: true, level: 'violence' })
    expect(S.safeSearchVerdict(null)).toEqual({ flag: false, level: null })
  })
  test('a still must be the caller\'s own, of this room, a jpeg', () => {
    expect(S.snapshotPathFor('liveSnapshots/H1/R1/1.jpg', 'H1', 'R1')).toBe('liveSnapshots/H1/R1/1.jpg')
    expect(S.snapshotPathFor('liveSnapshots/H2/R1/1.jpg', 'H1', 'R1')).toBe(null)
    expect(S.snapshotPathFor('liveSnapshots/H1/R2/1.jpg', 'H1', 'R1')).toBe(null)
    expect(S.snapshotPathFor('liveSnapshots/H1/R1/../x.jpg', 'H1', 'R1')).toBe(null)
    expect(S.snapshotPathFor('liveSnapshots/H1/R1/1.png', 'H1', 'R1')).toBe(null)
  })
  test('strikes: counted inside the window, restarted after it, silenced at the Owner\'s count', () => {
    const c = S.SAFETY_DEFAULTS
    const a = S.nextStrikes(undefined, 1000, c)
    expect(a).toEqual({ count: 1, windowStart: 1000, muted: false })
    const b = S.nextStrikes(a, 2000, c)
    const third = S.nextStrikes(b, 3000, c)
    expect(third.muted).toBe(true)
    expect(S.nextStrikes(third, 3000 + 61 * 60_000, c)).toEqual({ count: 1, windowStart: 3000 + 61 * 60_000, muted: false })
  })
})

describe('reportLiveSnapshot', () => {
  function room(extra = {}) { db.seed('liveRooms/R1', { hostUid: 'H1', isActive: true, ...extra }) }

  test('the AI check off: the newest still is kept, the one before deleted, the next asked for in 60 s', async () => {
    room({ lastSnapshotPath: 'liveSnapshots/H1/R1/old.jpg' })
    files.set('liveSnapshots/H1/R1/new.jpg', true); files.set('liveSnapshots/H1/R1/old.jpg', true)
    const r = await index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/new.jpg' }, ctx('H1'))
    expect(r).toEqual({ next: 60, ended: false, flagged: false })
    expect(db.read('liveRooms/R1').lastSnapshotPath).toBe('liveSnapshots/H1/R1/new.jpg')
    expect(deleted).toEqual(['liveSnapshots/H1/R1/old.jpg'])
    expect(db.count('safetyFlags')).toBe(0)
  })

  test('the check on: an adult verdict flags the room and keeps the still — the room stays up unless asked', async () => {
    db.seed('appConfig/safety', { visionEnabled: true })
    room()
    files.set('liveSnapshots/H1/R1/a.jpg', true)
    S.vision.safeSearch = async (uri) => { expect(uri).toBe('gs://demo-bucket/liveSnapshots/H1/R1/a.jpg'); return { adult: 'VERY_LIKELY', racy: 'LIKELY' } }
    const r = await index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/a.jpg' }, ctx('H1'))
    expect(r.flagged).toBe(true)
    expect(r.ended).toBe(false)
    const roomNow = db.read('liveRooms/R1')
    expect(roomNow.isActive).toBe(true)
    expect(roomNow.safetyFlag.level).toBe('adult')
    const flags = db.all('safetyFlags')
    expect(flags.length).toBe(1)
    expect(flags[0].kind).toBe('live_still')
    expect(flags[0].hostUid).toBe('H1')
    expect(flags[0].status).toBe('open')
  })

  test('with automatic ending on, an adult verdict ends the room at once', async () => {
    db.seed('appConfig/safety', { visionEnabled: true, autoEndOnAdult: true })
    room()
    files.set('liveSnapshots/H1/R1/a.jpg', true)
    S.vision.safeSearch = async () => ({ adult: 'LIKELY' })
    const r = await index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/a.jpg' }, ctx('H1'))
    expect(r.ended).toBe(true)
    const roomNow = db.read('liveRooms/R1')
    expect(roomNow.isActive).toBe(false)
    expect(roomNow.endedByStaff).toBe(true)
    expect(String(roomNow.endReason)).toBe('Ended automatically: explicit content was detected on camera.')
  })

  test('a Vision failure (API not enabled) is recorded on the room and nothing else changes', async () => {
    db.seed('appConfig/safety', { visionEnabled: true, autoEndOnAdult: true })
    room()
    files.set('liveSnapshots/H1/R1/a.jpg', true)
    S.vision.safeSearch = async () => { throw new Error('Cloud Vision API has not been used in project 1 before or it is disabled.') }
    const r = await index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/a.jpg' }, ctx('H1'))
    expect(r).toEqual({ next: 60, ended: false, flagged: false })
    expect(String(db.read('liveRooms/R1').lastSafeSearchError).includes('Cloud Vision API')).toBe(true)
    expect(db.read('liveRooms/R1').isActive).toBe(true)
  })

  test('refused: not the broadcaster, another room\'s path, a still not uploaded, signed out', async () => {
    room()
    files.set('liveSnapshots/V1/R1/a.jpg', true)
    expect((await refusal(index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/V1/R1/a.jpg' }, ctx('V1')))).code).toBe('permission-denied')
    expect((await refusal(index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R9/a.jpg' }, ctx('H1')))).code).toBe('invalid-argument')
    expect((await refusal(index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/missing.jpg' }, ctx('H1')))).code).toBe('not-found')
    expect((await refusal(index.reportLiveSnapshot.run({ roomId: 'R1', path: 'liveSnapshots/H1/R1/a.jpg' }, {}))).code).toBe('unauthenticated')
  })
})

describe('the chat triggers', () => {
  async function liveComment(id, uid, message) {
    db.seed(`liveRooms/L1/comments/${id}`, { uid, name: uid, message, timestamp: Date.now(), isJoin: false })
    const snap = await db.collection('liveRooms').doc('L1').collection('comments').doc(id).get()
    await index.screenLiveComment.run(snap, { params: { roomId: 'L1', commentId: id } })
    return db.read(`liveRooms/L1/comments/${id}`)
  }

  test('live: masked in place, a strike each time, silenced on the third with a flag for staff', async () => {
    db.seed('liveRooms/L1', { hostUid: 'H1', isActive: true, mutedViewers: [] })
    const clean = await liveComment('c0', 'V1', 'hello everyone')
    expect(clean.message).toBe('hello everyone')
    expect(clean.masked).toBe(undefined)
    const one = await liveComment('c1', 'V1', 'send nudes')
    expect(one.message).toBe('send *****')
    expect(one.masked).toBe(true)
    await liveComment('c2', 'V1', 'b!tch')
    expect(db.read('liveRooms/L1').mutedViewers).toEqual([])
    await liveComment('c3', 'V1', 'chutiya')
    expect(db.read('liveRooms/L1').mutedViewers).toEqual(['V1'])
    const flags = db.all('safetyFlags')
    expect(flags.length).toBe(1)
    expect(flags[0].kind).toBe('live_chat')
    expect(flags[0].uid).toBe('V1')
    expect(flags[0].muted).toBe(true)
  })

  test('party: masked, and silenced in that room through chatMutedUsers', async () => {
    db.seed('partyRooms/P1', { hostUid: 'H1', isActive: true })
    db.seed('appConfig/safety', { muteAfterStrikes: 1 })
    db.seed('partyRooms/P1/messages/m1', { senderUid: 'V2', text: 'madarchod', isJoin: false })
    const snap = await db.collection('partyRooms').doc('P1').collection('messages').doc('m1').get()
    await index.screenPartyMessage.run(snap, { params: { roomId: 'P1', messageId: 'm1' } })
    expect(db.read('partyRooms/P1/messages/m1').text).toBe('*********')
    expect(db.read('partyRooms/P1').chatMutedUsers).toEqual(['V2'])
  })

  test('a direct message is masked; a join row and a photo are left alone', async () => {
    db.seed('conversations/A_B/messages/d1', { senderUid: 'A', type: 'text', text: 'you are a whore' })
    db.seed('conversations/A_B/messages/d2', { senderUid: 'A', type: 'image', text: 'whore' })
    for (const id of ['d1', 'd2']) {
      const snap = await db.collection('conversations').doc('A_B').collection('messages').doc(id).get()
      await index.screenDirectMessage.run(snap, { params: { convoId: 'A_B', messageId: id } })
    }
    expect(db.read('conversations/A_B/messages/d1').text).toBe('you are a *****')
    expect(db.read('conversations/A_B/messages/d2').text).toBe('whore')
  })
})

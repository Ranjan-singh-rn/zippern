/**
 * Audit fixes D, E, F (system audit 1 Nov 2026, areas/02-functions.md):
 *
 *   D  F-4 / M-7 — the weekly report label carries the ISO WEEK-YEAR: the
 *      week starting 28 Dec 2026 is `2026-W53`, the one starting 4 Jan 2027
 *      is `2027-W01`. The label used to take the calendar year of the date,
 *      which would have filed the run of 10 Jan 2027 under `2027-W53`.
 *   E  F-16 — the public projection does not expose `hostLevel` for an
 *      account that does not hold the Host role, and does not list a
 *      suspended account.
 *   F  F-6 — the Agora token is never signed for uid 0 and never for a number
 *      the client chose: the server derives a stable non-zero 31-bit uid from
 *      the Firebase uid, signs it, and returns it; a party seat keeps its seat
 *      uid; a channel that resolves to nothing is refused.
 *
 * Run:  node --test test/auditFixesDEF.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const path = require('node:path')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()

// index.ts needs these to describe its scheduled functions and to sign.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-audit-fixes'
process.env.AGORA_APP_ID = 'a'.repeat(32)
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32)

const T = require('../lib/time')
const { project } = require('../lib/profiles')
const { deriveAgoraUid } = require('../lib/agoraUid')
const index = require('../lib/index')
const { RtcTokenBuilder, RtcRole } = require('agora-access-token')

// ══ D ════════════════════════════════════════════════════════════════════════

describe('D: ISO week-year on the weekly label', () => {
  test('the week starting Monday 28 Dec 2026 is 2026-W53', () => {
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2026, 11, 28)))).toBe('2026-W53')
    // …and every day of it, including the Sunday that falls in calendar 2027.
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2026, 11, 31)))).toBe('2026-W53')
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2027, 0, 1)))).toBe('2026-W53')
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2027, 0, 3)))).toBe('2026-W53')
  })
  test('the week starting Monday 4 Jan 2027 is 2027-W01', () => {
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2027, 0, 4)))).toBe('2027-W01')
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2027, 0, 10)))).toBe('2027-W01')
  })
  test('a normal week in the middle of the year', () => {
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2026, 8, 12)))).toBe('2026-W37')   // Saturday 12 Sep 2026
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2026, 10, 1)))).toBe('2026-W44')   // Sunday 1 Nov 2026
  })
  test('the report run of Sunday 10 Jan 2027 18:29 UTC labels the closed week 2026-W53, not 2027-W53', () => {
    // index.ts: weekStart = now − 7 days, label = isoWeekLabelUtc(weekStart).
    const run = Date.UTC(2027, 0, 10, 18, 29)
    const weekStart = new Date(run - 7 * 24 * 60 * 60 * 1000)        // Sunday 3 Jan 2027
    expect(T.isoWeekLabelUtc(weekStart)).toBe('2026-W53')
    expect(T.isoWeekLabelUtc(new Date(run))).toBe('2027-W01')
  })
  test('the first days of a year that starts mid-week belong to the previous week-year', () => {
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2021, 0, 1)))).toBe('2020-W53')   // Friday 1 Jan 2021
    expect(T.isoWeekLabelUtc(new Date(Date.UTC(2024, 11, 30)))).toBe('2025-W01') // Monday 30 Dec 2024
  })
  test('istWeekKey is the same rule cut in IST, and index.ts uses the shared label', () => {
    // 23:30 UTC on Sunday 3 Jan 2027 is already Monday 05:00 IST → 2027-W01.
    expect(T.istWeekKey(new Date(Date.UTC(2027, 0, 3, 23, 30)))).toBe('2027-W01')
    expect(T.istWeekKey(new Date(Date.UTC(2027, 0, 3, 12, 0)))).toBe('2026-W53')
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src.includes('const weekLabel = isoWeekLabelUtc(new Date(weekStartMs))')).toBe(true)
    expect(src.includes('function getISOWeekNumber')).toBe(false)
  })
})

// ══ E ════════════════════════════════════════════════════════════════════════

describe('E: the public projection', () => {
  test('hostLevel is exposed for a Host only', () => {
    expect(project('U', { isHost: true, hostLevel: 4 }, false).hostLevel).toBe(4)
    expect(project('U', { isHost: false, hostLevel: 4 }, false).hostLevel).toBe(0)
    expect(project('U', { hostLevel: 4 }, false).hostLevel).toBe(0)
    // Written as 0, not omitted: the projection is merged and a stale value would survive.
    expect('hostLevel' in project('U', { isHost: false, hostLevel: 4 }, false)).toBe(true)
  })
  test('a suspended account is not listed, whichever flag the writer set', () => {
    const complete = { isProfileComplete: true }
    expect(project('U', { ...complete }, false).isListed).toBe(true)
    expect(project('U', { ...complete, isSuspended: true }, false).isListed).toBe(false)
    expect(project('U', { ...complete, accountState: 'suspended' }, false).isListed).toBe(false)
    expect(project('U', { ...complete, isSuspended: true, isBanned: true, accountState: 'suspended' }, false).isListed).toBe(false)
    // The existing exclusions stand.
    expect(project('U', { ...complete, isBanned: true }, false).isListed).toBe(false)
    expect(project('U', { ...complete, isDeleted: true }, false).isListed).toBe(false)
    expect(project('U', { isProfileComplete: false }, false).isListed).toBe(false)
  })
  test('a suspension re-projects: the trigger watches the two flags', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'profiles.ts'), 'utf8')
    const watched = src.slice(src.indexOf('const WATCHED = ['), src.indexOf(']', src.indexOf('const WATCHED = [')))
    expect(watched.includes("'isSuspended'")).toBe(true)
    expect(watched.includes("'accountState'")).toBe(true)
  })
})

// ══ F ════════════════════════════════════════════════════════════════════════

describe('F: the derived Agora uid', () => {
  test('is stable, non-zero, 31-bit, and an integer', () => {
    const a = deriveAgoraUid('firebase-uid-A')
    expect(a).toBe(deriveAgoraUid('firebase-uid-A'))
    expect(Number.isInteger(a)).toBe(true)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThanOrEqual(0x7fffffff)
    expect(deriveAgoraUid('firebase-uid-A')).not.toBe(deriveAgoraUid('firebase-uid-B'))
  })
  test('no collision among 10,000 different uids', () => {
    const seen = new Set()
    for (let i = 0; i < 10_000; i++) seen.add(deriveAgoraUid(`user-${i}-${i * 7919}`))
    expect(seen.size).toBe(10_000)
  })
  test('is exactly the first four bytes of SHA-256, masked to 31 bits', () => {
    const crypto = require('crypto')
    const uid = 'abc123'
    const expected = crypto.createHash('sha256').update(uid, 'utf8').digest().readUInt32BE(0) & 0x7fffffff
    expect(deriveAgoraUid(uid)).toBe(expected || 1)
  })
  test('refuses an empty uid rather than deriving a number for nobody', () => {
    expect(() => deriveAgoraUid('')).toThrow()
  })
})

describe('F: generateAgoraToken signs the derived uid and returns it', () => {
  const TOKEN = { auth_time: 2000, firebase: { sign_in_provider: 'phone' } }
  const call = (uid, data) => index.generateAgoraToken.run(data, { auth: { uid, token: TOKEN } })
  async function refusal(p) { try { await p } catch (e) { return e } return null }

  // The token the server signed must equal the one built for the same uid, role
  // and expiry — the builder is deterministic given those and the credentials.
  const sameAs = (r, channel, uid, role) =>
    RtcTokenBuilder.buildTokenWithUid('a'.repeat(32), 'b'.repeat(32), channel, uid, role, Math.floor(r.expiresAt / 1000))

  beforeEach(() => { db._docs.clear() })

  test('a viewer joining a live room: the response carries the derived uid, and the token was signed for it', async () => {
    db.seed('users/V1', { name: 'Viewer' })
    db.seed('users/H1', { name: 'Host', isHost: true, isVerifiedHost: true })
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true })
    const r = await call('V1', { channelName: 'LIVE1', uid: 0 })
    expect(r.uid).toBe(deriveAgoraUid('V1'))
    expect(r.uid).toBeGreaterThan(0)
    expect(r.role).toBe('subscriber')
    expect(r.channelName).toBe('LIVE1')
    expect(typeof r.token).toBe('string')
    expect(r.appId).toBe('a'.repeat(32))
    expect(r.expiresAt - Date.now()).toBeGreaterThan(3500 * 1000)
    expect(r.expiresAt - Date.now()).toBeLessThanOrEqual(3600 * 1000)
    expect(r.token).toBe(sameAs(r, 'LIVE1', deriveAgoraUid('V1'), RtcRole.SUBSCRIBER))
    expect(r.token).not.toBe(sameAs(r, 'LIVE1', 0, RtcRole.SUBSCRIBER))
  })

  test('a client-chosen uid is ignored — the host\'s uid cannot be taken by a viewer', async () => {
    db.seed('users/V1', { name: 'Viewer' })
    db.seed('users/H1', { name: 'Host', isHost: true, isVerifiedHost: true })
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true })
    const r = await call('V1', { channelName: 'LIVE1', uid: deriveAgoraUid('H1') })
    expect(r.uid).toBe(deriveAgoraUid('V1'))
    expect(r.uid).not.toBe(deriveAgoraUid('H1'))
  })

  test('a call: both parties publish, each on their own derived uid', async () => {
    db.seed('users/A', { name: 'A' })
    db.seed('users/B', { name: 'B' })
    db.seed('calls/C1', { callerId: 'A', receiverId: 'B', status: 'connected' })
    const a = await call('A', { channelName: 'C1', uid: 0 })
    const b = await call('B', { channelName: 'C1', uid: 0 })
    expect(a.role).toBe('publisher')
    expect(b.role).toBe('publisher')
    expect(a.uid).toBe(deriveAgoraUid('A'))
    expect(b.uid).toBe(deriveAgoraUid('B'))
    expect(a.uid).not.toBe(b.uid)
    expect(a.token).toBe(sameAs(a, 'C1', a.uid, RtcRole.PUBLISHER))
  })

  test('a party seat keeps its seat uid; a listener without a seat gets the derived uid', async () => {
    db.seed('users/S', { name: 'Seated' })
    db.seed('users/L', { name: 'Listener' })
    db.seed('partyRooms/P1', { hostUid: 'S', isActive: true, visibility: 'public' })
    db.seed('partyRooms/P1/seats/3', { uid: 'S', agoraUid: 3 })
    const seated = await call('S', { channelName: 'party_P1', uid: 0 })
    expect(seated.uid).toBe(3)
    expect(seated.role).toBe('publisher')
    const listener = await call('L', { channelName: 'party_P1', uid: 0 })
    expect(listener.uid).toBe(deriveAgoraUid('L'))
    expect(listener.role).toBe('subscriber')
  })

  test('re-issuing a token for an active room is the same uid and writes nothing', async () => {
    db.seed('users/V1', { name: 'Viewer' })
    db.seed('users/H1', { name: 'Host', isHost: true, isVerifiedHost: true })
    db.seed('liveRooms/LIVE1', { hostUid: 'H1', isActive: true })
    const writesBefore = db.writes
    const first = await call('V1', { channelName: 'LIVE1' })
    const again = await call('V1', { channelName: 'LIVE1' })
    expect(again.uid).toBe(first.uid)
    expect(db.writes).toBe(writesBefore)
    const host = await call('H1', { channelName: 'LIVE1' })
    expect(host.role).toBe('publisher')
    expect(host.uid).toBe(deriveAgoraUid('H1'))
    expect((await call('H1', { channelName: 'LIVE1' })).uid).toBe(host.uid)
    expect(db.writes).toBe(writesBefore)
  })

  test('a channel that is not a room, a party, a call or a PK is refused, not downgraded to SUBSCRIBER', async () => {
    db.seed('users/V1', { name: 'Viewer' })
    const e = await refusal(call('V1', { channelName: 'nothing-here', uid: 0 }))
    expect(e && e.code).toBe('not-found')
    expect(e.message).toBe('No such room or call.')
  })

  test('the certificate is still read from the environment exactly as before (source)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src.includes("const appCertificate: string = process.env.AGORA_APP_CERTIFICATE || ''")).toBe(true)
    expect(src.includes('deriveAgoraUid(callerUid)')).toBe(true)
    expect(src.includes('(data.uid as number) || 0')).toBe(false)
  })
})

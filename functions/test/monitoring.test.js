/**
 * O12 (Owner, 5 Nov 2026) — silent monitoring, executed against the in-memory Firestore (lib/).
 *
 *   "Don't let those persons who are sitting in the party know they are being monitored … unless the official joined
 *    through the application. An agency can monitor its hosts and its sub-agencies; a sub-agency can monitor its
 *    hosts."
 *
 *   * who may watch which room (staff any room; an agency its own hosts and its sub-agencies' hosts; a sub-agency its
 *     own hosts; nobody else; a restricted account never);
 *   * the token is a SUBSCRIBER token for the room's channel under the monitor's own uid;
 *   * NOTHING is written in the room — no viewer row, no listener row, no join comment — and the watch is recorded in
 *     `monitorSessions`, which no client can read;
 *   * a private party room needs no PIN for a monitor; a kick list does not stop one; an ended room refuses.
 *
 * Run:  node --test test/monitoring.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')
const fs = require('fs')
const path = require('path')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
process.env.AGORA_APP_ID = 'a'.repeat(32)
process.env.AGORA_APP_CERTIFICATE = 'b'.repeat(32)

const M = require('../lib/monitoring')
const index = require('../lib/index')
const { deriveAgoraUid } = require('../lib/agoraUid')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000, firebase: { sign_in_provider: 'password' } } } })
async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

function world() {
  // A main agency A1 with a sub-agency S1 under it; another main agency A2.
  db.seed('agencies/A1', { type: 'main', agencyName: 'Alpha', isActive: true })
  db.seed('agencies/S1', { type: 'sub', parentAgencyId: 'A1', agencyName: 'Alpha South', isActive: true })
  db.seed('agencies/A2', { type: 'main', agencyName: 'Beta', isActive: true })
  // Hosts: H1 under A1, H2 under S1, H3 under A2.
  db.seed('users/H1', { name: 'Host One', isHost: true, agencyId: 'A1' })
  db.seed('users/H2', { name: 'Host Two', isHost: true, agencyId: 'S1' })
  db.seed('users/H3', { name: 'Host Three', isHost: true, agencyId: 'A2' })
  // Logins.
  db.seed('crmUsers/AG1', { role: 'agency', agencyId: 'A1', isActive: true, status: 'approved' })
  db.seed('crmUsers/SUB1', { role: 'agency', agencyId: 'S1', isActive: true, status: 'approved' })
  db.seed('crmUsers/OPS', { role: 'ops_member', isActive: true })
  db.seed('crmUsers/OWN', { role: 'superadmin', isActive: true })
  db.seed('crmUsers/FIN', { role: 'finance_admin', isActive: true })
  db.seed('users/V1', { name: 'Viewer' })
  // Rooms.
  db.seed('liveRooms/L1', { hostUid: 'H1', isActive: true, viewerCount: 3, kickedViewers: ['OPS'] })
  db.seed('liveRooms/L2', { hostUid: 'H2', isActive: true })
  db.seed('liveRooms/L3', { hostUid: 'H3', isActive: true })
  db.seed('liveRooms/LX', { hostUid: 'H1', isActive: false })
  db.seed('partyRooms/P1', { hostUid: 'H2', isActive: true, visibility: 'private', kickedUsers: ['AG1'] })
}

beforeEach(() => { db._docs.clear(); world() })

describe('who may monitor which room (pure)', () => {
  const crm = (role, extra = {}) => ({ role, isActive: true, ...extra })
  const ag = (id, extra = {}) => ({ id, type: 'main', isActive: true, ...extra })
  const sub = (id, parent) => ({ id, type: 'sub', parentAgencyId: parent, isActive: true })

  test('the Owner and the room teams watch any room; finance and marketing do not', () => {
    for (const r of ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member', 'tech_admin', 'tech_member', 'support_admin']) {
      expect(M.monitorAccess({ crm: crm(r), ownAgency: null, hostAgency: null, callerBanned: false })).toEqual({ allowed: true, as: 'staff' })
    }
    for (const r of ['finance_admin', 'finance_member', 'marketing_admin', 'marketing_member', 'support_member']) {
      expect(M.monitorAccess({ crm: crm(r), ownAgency: null, hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    }
  })

  test('an agency watches its own hosts and its sub-agencies\' hosts, not another agency\'s', () => {
    const me = crm('agency', { agencyId: 'A1' })
    expect(M.monitorAccess({ crm: me, ownAgency: ag('A1'), hostAgency: ag('A1'), callerBanned: false })).toEqual({ allowed: true, as: 'agency' })
    expect(M.monitorAccess({ crm: me, ownAgency: ag('A1'), hostAgency: sub('S1', 'A1'), callerBanned: false })).toEqual({ allowed: true, as: 'agency' })
    expect(M.monitorAccess({ crm: me, ownAgency: ag('A1'), hostAgency: ag('A2'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: me, ownAgency: ag('A1'), hostAgency: sub('S9', 'A2'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: me, ownAgency: ag('A1'), hostAgency: null, callerBanned: false }).reason)
      .toBe('This host is not with your agency.')
  })

  test('a sub-agency watches only its own hosts — not its parent\'s, not a sibling\'s', () => {
    const me = crm('agency', { agencyId: 'S1' })
    expect(M.monitorAccess({ crm: me, ownAgency: sub('S1', 'A1'), hostAgency: sub('S1', 'A1'), callerBanned: false }))
      .toEqual({ allowed: true, as: 'sub_agency' })
    expect(M.monitorAccess({ crm: me, ownAgency: sub('S1', 'A1'), hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: me, ownAgency: sub('S1', 'A1'), hostAgency: sub('S2', 'A1'), callerBanned: false }).allowed).toBe(false)
  })

  test('refused: a restricted account, no CRM login, a seller, a revoked or inactive agency, a deactivated staff login', () => {
    expect(M.monitorAccess({ crm: crm('superadmin'), ownAgency: null, hostAgency: null, callerBanned: true }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: null, ownAgency: null, hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: crm('seller'), ownAgency: null, hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: crm('agency', { roleStatus: { agency: 'revoked' } }), ownAgency: ag('A1'), hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: crm('agency'), ownAgency: ag('A1', { isActive: false }), hostAgency: ag('A1'), callerBanned: false }).allowed).toBe(false)
    expect(M.monitorAccess({ crm: crm('ops_admin', { isActive: false }), ownAgency: null, hostAgency: null, callerBanned: false }).allowed).toBe(false)
  })

  test('the monitor\'s Agora uid is its own — never the account\'s viewer or caller uid', () => {
    expect(M.monitorAgoraUid('OPS')).not.toBe(deriveAgoraUid('OPS'))
    expect(M.monitorAgoraUid('OPS')).toBe(M.monitorAgoraUid('OPS'))
    expect(M.monitorAgoraUid('OPS') > 0).toBe(true)
  })
})

describe('monitorRoomToken', () => {
  test('staff get a SUBSCRIBER token for a live room — and nothing is written in the room', async () => {
    const before = db.all('liveRooms').length
    const r = await index.monitorRoomToken.run({ kind: 'live', roomId: 'L1' }, ctx('OPS'))
    expect(r.role).toBe('subscriber')
    expect(r.channelName).toBe('L1')
    expect(r.uid).toBe(M.monitorAgoraUid('OPS'))
    expect(r.as).toBe('staff')
    expect(typeof r.token === 'string' && r.token.length > 20).toBe(true)
    // Silent: no viewer row, no join comment, the count untouched — the kick list did not stop staff either.
    expect(db.count('liveRooms/L1/viewers')).toBe(0)
    expect(db.count('liveRooms/L1/comments')).toBe(0)
    expect(db.read('liveRooms/L1').viewerCount).toBe(3)
    expect(db.all('liveRooms').length).toBe(before)
    // Recorded.
    const rows = db.all('monitorSessions')
    expect(rows.length).toBe(1)
    expect(rows[0].monitorUid).toBe('OPS')
    expect(rows[0].kind).toBe('live')
    expect(rows[0].roomId).toBe('L1')
    expect(rows[0].hostUid).toBe('H1')
    expect(rows[0].as).toBe('staff')
  })

  test('an agency watches a private party room of its sub-agency\'s host without a PIN or a listener row', async () => {
    const r = await index.monitorRoomToken.run({ kind: 'party', roomId: 'P1' }, ctx('AG1'))
    expect(r.channelName).toBe('party_P1')
    expect(r.as).toBe('agency')
    expect(db.count('partyRooms/P1/listeners')).toBe(0)
    expect(db.count('partyRooms/P1/seats')).toBe(0)
  })

  test('a sub-agency watches its own host, and is refused another agency\'s', async () => {
    const r = await index.monitorRoomToken.run({ kind: 'live', roomId: 'L2' }, ctx('SUB1'))
    expect(r.as).toBe('sub_agency')
    const e = await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'L3' }, ctx('SUB1')))
    expect(e && e.code).toBe('permission-denied')
    expect(db.count('monitorSessions')).toBe(1)
  })

  test('refused: an ordinary user, finance, an ended room, a bad request, signed out', async () => {
    expect((await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'L1' }, ctx('V1')))).code).toBe('permission-denied')
    expect((await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'L1' }, ctx('FIN')))).code).toBe('permission-denied')
    expect((await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'LX' }, ctx('OWN')))).code).toBe('failed-precondition')
    expect((await refusal(index.monitorRoomToken.run({ kind: 'call', roomId: 'L1' }, ctx('OWN')))).code).toBe('invalid-argument')
    expect((await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'a/b' }, ctx('OWN')))).code).toBe('invalid-argument')
    expect((await refusal(index.monitorRoomToken.run({ kind: 'live', roomId: 'L1' }, {}))).code).toBe('unauthenticated')
    expect(db.count('monitorSessions')).toBe(0)
  })

  test('the list: staff see every open room; an agency its hosts\' and its sub-agencies\'; a sub-agency its own', async () => {
    const ids = (r) => r.rooms.map((x) => `${x.kind}:${x.roomId}`).sort()
    const staff = await index.myMonitorRooms.run({}, ctx('OWN'))
    expect(staff.as).toBe('staff')
    expect(ids(staff)).toEqual(['live:L1', 'live:L2', 'live:L3', 'party:P1'])
    const agency = await index.myMonitorRooms.run({}, ctx('AG1'))
    expect(agency.as).toBe('agency')
    expect(ids(agency)).toEqual(['live:L1', 'live:L2', 'party:P1'])
    expect(agency.rooms.find((x) => x.roomId === 'P1').private).toBe(true)
    const sub = await index.myMonitorRooms.run({}, ctx('SUB1'))
    expect(sub.as).toBe('sub_agency')
    expect(ids(sub)).toEqual(['live:L2', 'party:P1'])
    expect((await refusal(index.myMonitorRooms.run({}, ctx('V1')))).code).toBe('permission-denied')
    expect((await refusal(index.myMonitorRooms.run({}, ctx('FIN')))).code).toBe('permission-denied')
    // Listing writes nothing anywhere.
    expect(db.count('monitorSessions')).toBe(0)
  })

  test('no client can read or write the record of who watched (firestore.rules)', () => {
    const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    // No rule names the collection, so the deny-everything-else match covers it.
    expect(rules.includes('monitorSessions')).toBe(false)
    expect(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/.test(rules)).toBe(true)
  })
})

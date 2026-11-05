/**
 * O12 (Owner, 5 Nov 2026) — silent monitoring of live and party rooms.
 *
 *   "When it is monitoring in the CRM or maybe in the application, don't let those persons who are sitting in the
 *    party know … unless the official itself joined that party room through the application. Make the monitoring
 *    flow such that an agency can monitor its hosts and its sub-agencies, and a sub-agency can monitor its hosts."
 *
 * ── What "silent" means here ──────────────────────────────────────────────────────────────────────────────────────
 *
 * [monitorRoomToken] hands a monitor an Agora SUBSCRIBER token for the room's channel and NOTHING else: no
 * `viewers/{uid}` row (the live viewer list and count), no `listeners/{uid}` row (the party listener list), no join
 * comment, no arrival banner, no seat. Every room uses LIVE_BROADCASTING, where an audience member is invisible to the
 * others in the channel — Agora tells the room about publishers only. So nobody in the room can tell they are being
 * watched. An official who joins through the app the ordinary way (`joinPartyRoom`, the live join) is visible like
 * anyone else — the Owner's exception.
 *
 * It is not unrecorded: every token is a row in `monitorSessions` (server-only; no client reads or writes it) — who,
 * as what, which room, whose room, when. Acting on a room (warn, end, ban) goes through the CRM's audited endpoints as
 * before; watching is not an action.
 *
 * ── Who may monitor which room ([monitorAccess], pure) ───────────────────────────────────────────────────────────
 *
 *   * ZIPPER staff who work on rooms — an Owner (`superadmin`) and the app, ops, tech and support teams (the same
 *     set the CRM's live page admits) — any room.
 *   * An approved Agency login — rooms hosted by ITS hosts (users/{host}.agencyId is its agency) and by the hosts of
 *     its sub-agencies (that agency's `parentAgencyId` is its agency).
 *   * An approved Sub-agency login — rooms hosted by its own hosts only.
 *   * Anyone else — refused (permission-denied), and a restricted account is refused whatever it holds.
 *
 * A monitor is not subject to a host's kick or block list (those keep a VIEWER out; the agency answers for its host),
 * and needs no PIN for a private party room (the PIN keeps the public out, not the people responsible for the room).
 */

import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { deriveAgoraUid } from './agoraUid'
import { DEPARTMENT_ROLES, OWNER_ROLE, deriveRoleFlags, normaliseCrmRole } from './crmRoles'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RtcTokenBuilder, RtcRole } = require('agora-access-token')

const db = (): admin.firestore.Firestore => admin.firestore()

/** The staff who may watch any room: the Owner and the teams the CRM's live page admits. */
export const MONITOR_STAFF_ROLES: ReadonlySet<string> = new Set([
  OWNER_ROLE,
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'tech_admin', 'tech_member',
  'support_admin',
])

/** A monitor token lasts this long; the CRM asks again (silently) to keep watching. */
export const MONITOR_TOKEN_TTL_S = 60 * 60

export type MonitorAs = 'staff' | 'agency' | 'sub_agency'

export interface AgencyRow {
  id: string
  /** 'main' (or absent) for a main agency, 'sub' for a sub-agency. */
  type?: unknown
  parentAgencyId?: unknown
  isActive?: unknown
  status?: unknown
}

export interface MonitorInput {
  /** `crmUsers/{caller}` — absent for an account with no CRM login. */
  crm: Record<string, unknown> | null
  /** The caller's own agency (crmUsers.agencyId), when they log in as an Agency / Sub-agency. */
  ownAgency: AgencyRow | null
  /** The agency the room's host works under (users/{host}.agencyId), when there is one. */
  hostAgency: AgencyRow | null
  /** users/{caller}.isBanned — a restricted account monitors nothing. */
  callerBanned: boolean
}

export interface MonitorDecision {
  allowed: boolean
  as?: MonitorAs
  /** The refusal, written to be shown. */
  reason?: string
}

const isSub = (a: AgencyRow | null): boolean => String(a?.type ?? '').trim().toLowerCase() === 'sub'
const agencyUsable = (a: AgencyRow | null): boolean =>
  !!a && a.isActive !== false && !['rejected', 'revoked', 'suspended'].includes(String(a.status ?? '').trim().toLowerCase())

/** Who may monitor a room hosted under [hostAgency], and as what. Pure — see the header. */
export function monitorAccess(input: MonitorInput): MonitorDecision {
  if (input.callerBanned) return { allowed: false, reason: 'This account is restricted.' }
  const crm = input.crm
  if (!crm) return { allowed: false, reason: 'Monitoring is for ZIPPER staff and agencies.' }
  const role = normaliseCrmRole(crm.role)
  const active = crm.isActive !== false
  if (active && (role === OWNER_ROLE || DEPARTMENT_ROLES.has(role))) {
    return MONITOR_STAFF_ROLES.has(role)
      ? { allowed: true, as: 'staff' }
      : { allowed: false, reason: 'Your team does not monitor rooms.' }
  }
  const flags = deriveRoleFlags(crm.role, crm.roles, active, true, crm.roleStatus, crm.status)
  if (!flags.isAgent) return { allowed: false, reason: 'Monitoring is for ZIPPER staff and agencies.' }
  const own = input.ownAgency
  if (!own || !agencyUsable(own)) return { allowed: false, reason: 'Your agency is not active.' }
  const host = input.hostAgency
  if (!host) return { allowed: false, reason: 'This host is not with your agency.' }
  if (host.id === own.id) return { allowed: true, as: isSub(own) ? 'sub_agency' : 'agency' }
  // A main agency watches its sub-agencies' hosts too; a sub-agency only its own.
  if (!isSub(own) && isSub(host) && String(host.parentAgencyId ?? '').trim() === own.id) {
    return { allowed: true, as: 'agency' }
  }
  return { allowed: false, reason: 'This host is not with your agency.' }
}

/** The monitor's own Agora uid — never the one their account would watch or call with, so the two never collide. */
export function monitorAgoraUid(callerUid: string): number {
  return deriveAgoraUid(`monitor:${callerUid}`)
}

async function agencyRow(id: string): Promise<AgencyRow | null> {
  const clean = String(id ?? '').trim()
  if (!clean) return null
  const snap = await db().collection('agencies').doc(clean).get()
  return snap.exists ? { id: clean, ...(snap.data() as Record<string, unknown>) } : null
}

/**
 * Callable: `{ kind: 'live' | 'party', roomId }` → `{ token, appId, uid, channelName, role: 'subscriber', expiresAt,
 * kind, roomId, hostUid, as }`. Writes one `monitorSessions` row and nothing in the room.
 */
export const monitorRoomToken = functions
  .region('asia-south1')
  .https.onCall(async (data: { kind?: unknown; roomId?: unknown }, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
    const callerUid = context.auth.uid
    const kind = data?.kind === 'party' ? 'party' : data?.kind === 'live' ? 'live' : ''
    const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
    if (!kind || !roomId || roomId.includes('/')) {
      throw new functions.https.HttpsError('invalid-argument', 'Say which room: kind live or party, and its id.')
    }

    const roomRef = db().collection(kind === 'live' ? 'liveRooms' : 'partyRooms').doc(roomId)
    const [roomSnap, crmSnap, callerSnap] = await Promise.all([
      roomRef.get(),
      db().collection('crmUsers').doc(callerUid).get(),
      db().collection('users').doc(callerUid).get(),
    ])
    if (!roomSnap.exists) throw new functions.https.HttpsError('not-found', 'No such room.')
    if (roomSnap.get('isActive') === false) {
      throw new functions.https.HttpsError('failed-precondition', kind === 'live' ? 'This live has ended.' : 'This room has closed.')
    }
    const hostUid = String(roomSnap.get('hostUid') ?? '')
    const hostSnap = hostUid ? await db().collection('users').doc(hostUid).get() : null
    const crm = crmSnap.exists ? (crmSnap.data() as Record<string, unknown>) : null
    const [ownAgency, hostAgency] = await Promise.all([
      crm ? agencyRow(String(crm.agencyId ?? '')) : Promise.resolve(null),
      hostSnap?.exists ? agencyRow(String(hostSnap.get('agencyId') ?? '')) : Promise.resolve(null),
    ])
    const decision = monitorAccess({
      crm, ownAgency, hostAgency, callerBanned: callerSnap.exists && callerSnap.get('isBanned') === true,
    })
    if (!decision.allowed) {
      functions.logger.info('monitor: refused', { kind, roomId, callerUid, reason: decision.reason })
      throw new functions.https.HttpsError('permission-denied', decision.reason ?? 'Not allowed.')
    }

    const appId = process.env.AGORA_APP_ID || ''
    const appCertificate = process.env.AGORA_APP_CERTIFICATE || ''
    if (!appId || !appCertificate) {
      throw new functions.https.HttpsError('failed-precondition', 'Agora credentials not configured on server.')
    }
    const channelName = kind === 'live' ? roomId : `party_${roomId}`
    const uid = monitorAgoraUid(callerUid)
    const expiresAtS = Math.floor(Date.now() / 1000) + MONITOR_TOKEN_TTL_S
    const token: string = RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, uid, RtcRole.SUBSCRIBER, expiresAtS)

    // The record of who watched — server-only (firestore.rules: no client access). NOTHING is written in the room.
    await db().collection('monitorSessions').add({
      monitorUid: callerUid,
      as: decision.as,
      kind,
      roomId,
      hostUid,
      agoraUid: uid,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtS * 1000),
    })
    functions.logger.info('monitor: token issued', { kind, roomId, callerUid, as: decision.as })
    return {
      token, appId, uid, channelName, role: 'subscriber', expiresAt: expiresAtS * 1000,
      kind, roomId, hostUid, as: decision.as,
    }
  })

// ── What a monitor may open right now ────────────────────────────────────────────────────────────────────────────

export interface MonitorRoom {
  kind: 'live' | 'party'
  roomId: string
  hostUid: string
  hostName: string
  title: string
  /** Viewers (live) or listeners + people on seats (party). */
  audience: number
  /** A PIN-locked party room (a monitor opens it without the PIN). */
  private: boolean
}

/** Firestore's `in` takes at most 30 values. */
const IN_CHUNK = 30
/** A cap per kind, so one call stays one screen. */
export const MONITOR_LIST_LIMIT = 200

function roomRow(kind: 'live' | 'party', d: FirebaseFirestore.QueryDocumentSnapshot): MonitorRoom {
  const x = d.data()
  return {
    kind,
    roomId: d.id,
    hostUid: String(x.hostUid ?? ''),
    hostName: String(x.hostName ?? ''),
    title: String(x.title ?? x.roomName ?? ''),
    audience: kind === 'live'
      ? Number(x.viewerCount ?? 0) || 0
      : (Number(x.listenerCount ?? 0) || 0) + (Number(x.occupantCount ?? 0) || 0),
    private: kind === 'party' && x.visibility === 'private',
  }
}

async function chunked<T>(values: string[], each: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(...await each(values.slice(i, i + IN_CHUNK)))
  return out
}

/**
 * Callable: the rooms the caller may monitor that are open right now, the busiest first — every room for staff; for
 * an Agency its hosts' and its sub-agencies' hosts' rooms; for a Sub-agency its own hosts' rooms. Read-only.
 */
export const myMonitorRooms = functions
  .region('asia-south1')
  .https.onCall(async (_data: unknown, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
    const callerUid = context.auth.uid
    const [crmSnap, callerSnap] = await Promise.all([
      db().collection('crmUsers').doc(callerUid).get(),
      db().collection('users').doc(callerUid).get(),
    ])
    const crm = crmSnap.exists ? (crmSnap.data() as Record<string, unknown>) : null
    const ownAgency = crm ? await agencyRow(String(crm.agencyId ?? '')) : null
    // The same decision as a token, asked about "a host of my own agency": it tells staff from partners and refuses
    // everybody else exactly as monitorRoomToken would.
    const decision = monitorAccess({
      crm, ownAgency, hostAgency: ownAgency, callerBanned: callerSnap.exists && callerSnap.get('isBanned') === true,
    })
    if (!decision.allowed) throw new functions.https.HttpsError('permission-denied', decision.reason ?? 'Not allowed.')

    let rooms: MonitorRoom[]
    if (decision.as === 'staff') {
      const [live, party] = await Promise.all([
        db().collection('liveRooms').where('isActive', '==', true).limit(MONITOR_LIST_LIMIT).get(),
        db().collection('partyRooms').where('isActive', '==', true).limit(MONITOR_LIST_LIMIT).get(),
      ])
      rooms = [...live.docs.map((d) => roomRow('live', d)), ...party.docs.map((d) => roomRow('party', d))]
    } else {
      const own = ownAgency as AgencyRow
      const agencyIds = [own.id]
      if (decision.as === 'agency') {
        const subs = await db().collection('agencies').where('parentAgencyId', '==', own.id).get()
        subs.docs.forEach((d) => { if (String(d.get('type') ?? '').trim().toLowerCase() === 'sub') agencyIds.push(d.id) })
      }
      const hosts = await chunked(agencyIds, async (chunk) =>
        (await db().collection('users').where('agencyId', 'in', chunk).get()).docs
          .filter((d) => d.get('isHost') === true).map((d) => d.id))
      const open = (kind: 'live' | 'party') => chunked(hosts, async (chunk) =>
        (await db().collection(kind === 'live' ? 'liveRooms' : 'partyRooms').where('hostUid', 'in', chunk).get()).docs
          .filter((d) => d.get('isActive') === true).map((d) => roomRow(kind, d)))
      const [live, party] = await Promise.all([open('live'), open('party')])
      rooms = [...live, ...party]
    }
    rooms.sort((a, b) => b.audience - a.audience)
    return { as: decision.as, rooms: rooms.slice(0, MONITOR_LIST_LIMIT * 2) }
  })

/**
 * B12 (4 Nov 2026) — live streaming, the server's half.
 *
 * The broadcaster's app still opens and closes its own room (`firestore.rules` allows only a verified, current
 * Host to open one), but four things could not stay with the phones:
 *
 *   1. WHO IS WATCHING. `viewerCount` was a counter every signed-in account could move by any amount, and the
 *      live list sorts on it. It is now recounted here from the presence rows (`viewers/{uid}`) whenever one is
 *      added or removed, with the room's peak alongside; the rules allow a client nothing but a ±1 step, which
 *      the next recount overwrites anyway.
 *   2. ROOMS NOBODY CLOSED. A crash or a killed process never ran "end live", and the room stayed `isActive`
 *      for ever — in the list, ranking the host as live. The host's app now touches `hostHeartbeatAt` every
 *      minute; [sweepLiveRooms] closes a room whose host has been silent for three minutes, one paused for more
 *      than fifteen, and (for builds without the heartbeat) one older than twelve hours. Stale presence rows go
 *      the same way.
 *   3. PK BATTLES. Matching, accepting and ending a PK wrote to BOTH hosts' rooms from one phone, and the rules
 *      (rightly) let a host change only their own room — so PK could never start. [pkMatch], [pkRespond] and
 *      [pkEnd] do it here, with the end time set by the server. Scores are added by `settleGift` in the gift's
 *      own transaction, from diamonds that actually moved (the phone's `addPKScore` is gone).
 *   4. THE DURATION. Streamed time was whatever the host's app said it was. `syncLivePresence` now measures it
 *      from the server's own start mark (see profiles.ts).
 *
 * Pure decisions are exported for `test/b12Live.test.js`.
 */

import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { assertActiveSession } from './mobileSession'

const db = (): admin.firestore.Firestore => admin.firestore()

/** The host's app touches the room this often; three missed beats and the room is closed. */
export const LIVE_HEARTBEAT_STALE_MS = 3 * 60_000
/** A pause longer than this ends the live — viewers are not left looking at a still frame for ever. */
export const LIVE_PAUSE_LIMIT_MS = 15 * 60_000
/** A room from a build without the heartbeat: closed once it is this old. */
export const LIVE_LEGACY_STALE_MS = 12 * 60 * 60_000
/** A presence row not refreshed for this long is somebody who left without saying so. */
export const VIEWER_STALE_MS = 3 * 60_000
/** A presence row from a build without the refresh: kept this long. */
export const VIEWER_LEGACY_STALE_MS = 6 * 60 * 60_000
/** A PK battle lasts three minutes (the app's `PK_DURATION_MS`). */
export const PK_DURATION_MS = 3 * 60_000
/** A PK past its end by this much is ended by the sweep if neither host ended it. */
export const PK_GRACE_MS = 10_000
/** The longest pinned message a host may set. */
export const PINNED_MAX = 140

type Millis = number

/** Firestore Timestamp, millis or nothing → millis or null. */
export function millisOf(v: unknown): Millis | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = v as { toMillis?: () => number }
  if (typeof t.toMillis === 'function') {
    const m = t.toMillis()
    return Number.isFinite(m) ? m : null
  }
  return null
}

export type StaleReason = 'host_lost' | 'paused_too_long' | 'legacy_stale'

/** Pure — should the sweep close this active room, and why. */
export function staleLiveRoom(room: Record<string, unknown>, nowMs: Millis): StaleReason | null {
  if (room.isActive !== true) return null
  if (room.isPaused === true) {
    const pausedAt = millisOf(room.pausedAt)
    if (pausedAt !== null && nowMs - pausedAt > LIVE_PAUSE_LIMIT_MS) return 'paused_too_long'
  }
  const beat = millisOf(room.hostHeartbeatAt)
  if (beat !== null) return nowMs - beat > LIVE_HEARTBEAT_STALE_MS ? 'host_lost' : null
  // No heartbeat ever: a build that does not send one. Judged by its age only.
  const started = millisOf(room.serverStartedAt) ?? millisOf(room.startedAt)
  if (started === null) return null
  return nowMs - started > LIVE_LEGACY_STALE_MS ? 'legacy_stale' : null
}

/** Pure — is this presence row somebody who has gone. */
export function viewerIsStale(viewer: Record<string, unknown>, nowMs: Millis): boolean {
  const seen = millisOf(viewer.lastSeenAt)
  if (seen !== null) return nowMs - seen > VIEWER_STALE_MS
  const joined = millisOf(viewer.joinedAt)
  return joined !== null && nowMs - joined > VIEWER_LEGACY_STALE_MS
}

/**
 * Pure — the streamed seconds the server stands behind: from its own start mark to [endMs]. Without a start mark
 * (a room older than this change), the host's figure, but never more than the room's own age.
 */
export function serverDurationSeconds(room: Record<string, unknown>, endMs: Millis): number {
  const serverStart = millisOf(room.serverStartedAt)
  if (serverStart !== null) return Math.max(0, Math.floor((endMs - serverStart) / 1000))
  const claimed = Math.max(0, Math.floor(Number(room.durationSeconds ?? 0)) || 0)
  const started = millisOf(room.startedAt)
  if (started === null) return 0
  return Math.min(claimed, Math.max(0, Math.floor((endMs - started) / 1000)))
}

/**
 * Pure — may this gift be settled in this live room. Null when it may; otherwise the sentence for the sender.
 * The money has not moved when this refuses.
 */
export function liveGiftRefusal(input: {
  room: Record<string, unknown>
  senderUid: string
  receiverUid: string
  senderBlockedByHost: boolean
}): string | null {
  const { room, senderUid, receiverUid, senderBlockedByHost } = input
  if (room.isActive !== true) return 'This live has ended.'
  const hostUid = String(room.hostUid ?? '')
  // The host of this room — or, during a PK, the host it is battling (both are on screen).
  const pkPartner = room.pkActive === true ? String(room.pkPartnerUid ?? '') : ''
  if (receiverUid !== hostUid && (pkPartner === '' || receiverUid !== pkPartner)) {
    return 'Gifts here go to the host.'
  }
  const kicked = Array.isArray(room.kickedViewers) ? (room.kickedViewers as unknown[]) : []
  if (kicked.includes(senderUid)) return 'You were removed from this live by the host.'
  if (senderBlockedByHost) return 'You can\'t send gifts in this live.'
  return null
}

/** Pure — who won a PK. */
export function pkWinner(scoreA: number, scoreB: number): 'A' | 'B' | 'draw' {
  if (scoreA > scoreB) return 'A'
  if (scoreB > scoreA) return 'B'
  return 'draw'
}

/** Pure — is the PK in this room still taking scores at [nowMs]. */
export function pkScoring(room: Record<string, unknown>, nowMs: Millis): boolean {
  return room.pkActive === true && Number(room.pkEndTime ?? 0) > nowMs
}

// ══════════════════════════════════════════════════════════════════════════════
//  Who is watching
// ══════════════════════════════════════════════════════════════════════════════

async function recountViewers(roomId: string): Promise<number | null> {
  const roomRef = db().collection('liveRooms').doc(roomId)
  const agg = await roomRef.collection('viewers').count().get()
  const count = Number(agg.data().count ?? 0)
  return db().runTransaction(async (tx) => {
    const room = await tx.get(roomRef)
    if (!room.exists) return null
    const peak = Math.max(Number(room.get('peakViewers') ?? 0) || 0, count)
    tx.update(roomRef, { viewerCount: count, peakViewers: peak })
    return count
  })
}

/**
 * A presence row was added or removed: recount. A refresh of an existing row (the minute's `lastSeenAt`) is not
 * a change in who is watching and costs nothing.
 */
export const liveViewerCount = functions
  .region('asia-south1')
  .firestore.document('liveRooms/{roomId}/viewers/{uid}')
  .onWrite(async (change, context) => {
    if (change.before.exists === change.after.exists) return null
    await recountViewers(String(context.params.roomId))
    return null
  })

// ══════════════════════════════════════════════════════════════════════════════
//  The sweep
// ══════════════════════════════════════════════════════════════════════════════

async function closeRoom(ref: admin.firestore.DocumentReference, reason: StaleReason, nowMs: Millis): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists || snap.get('isActive') !== true) return false
    // Re-judged inside the transaction: a heartbeat that landed since the query keeps the room open.
    if (staleLiveRoom(snap.data() as Record<string, unknown>, nowMs) === null) return false
    tx.update(ref, {
      isActive: false,
      isPaused: false,
      endedAt: admin.firestore.Timestamp.fromMillis(nowMs),
      endReason: reason,
    })
    return true
  })
}

export async function sweepLiveRoomsOnce(nowMs: Millis = Date.now()): Promise<{ closed: number; pkEnded: number; viewersPruned: number }> {
  let closed = 0
  let pkEnded = 0
  let viewersPruned = 0
  const active = await db().collection('liveRooms').where('isActive', '==', true).limit(300).get()
  for (const doc of active.docs) {
    const room = doc.data() as Record<string, unknown>
    const reason = staleLiveRoom(room, nowMs)
    if (room.pkActive === true && Number(room.pkEndTime ?? 0) + PK_GRACE_MS < nowMs) {
      try { if (await endPk(doc.id, 'time', nowMs)) pkEnded += 1 } catch (err) {
        functions.logger.warn('live sweep: PK not ended', { roomId: doc.id, err: String(err) })
      }
    }
    if (reason) {
      try {
        if (room.pkActive === true) await endPk(doc.id, 'host_left', nowMs)
        if (await closeRoom(doc.ref, reason, nowMs)) closed += 1
      } catch (err) {
        functions.logger.warn('live sweep: room not closed', { roomId: doc.id, err: String(err) })
      }
    }
    /*
     * Only the rows that are actually stale are read — two indexed range queries — not every viewer of every live
     * room every two minutes (300 rooms × 500 viewers would be 150,000 reads a run). A room being closed has all
     * its rows removed.
     */
    const viewersCol = doc.ref.collection('viewers')
    const staleDocs = reason !== null
      ? (await viewersCol.limit(500).get()).docs
      : [
          ...(await viewersCol.where('lastSeenAt', '<', admin.firestore.Timestamp.fromMillis(nowMs - VIEWER_STALE_MS)).limit(200).get()).docs,
          ...(await viewersCol.where('joinedAt', '<', nowMs - VIEWER_LEGACY_STALE_MS).limit(200).get()).docs
            .filter((v) => viewerIsStale(v.data() as Record<string, unknown>, nowMs)),
        ]
    const seen = new Set<string>()
    const stale = staleDocs.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
    await Promise.all(stale.map((v) => v.ref.delete().catch(() => undefined)))
    viewersPruned += stale.length
  }
  return { closed, pkEnded, viewersPruned }
}

export const sweepLiveRooms = functions
  .region('asia-south1')
  .pubsub.schedule('every 2 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const r = await sweepLiveRoomsOnce()
    if (r.closed || r.pkEnded || r.viewersPruned) functions.logger.info('live sweep', r)
    return null
  })

// ══════════════════════════════════════════════════════════════════════════════
//  PK battles
// ══════════════════════════════════════════════════════════════════════════════

function requireAuth(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  return context.auth.uid
}

const PK_CLEAR = {
  pkWaiting: false,
  pkActive: false,
  pkPartnerId: '',
  pkPartnerUid: '',
  pkPartnerName: '',
  pkPartnerPhotoUrl: '',
  pkScore: 0,
  pkPartnerScore: 0,
  pkEndTime: 0,
  pkChannelId: '',
  pkInviteId: '',
}

function requireOwnActiveRoom(snap: admin.firestore.DocumentSnapshot, uid: string): void {
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Live room not found.')
  if (snap.get('hostUid') !== uid) throw new functions.https.HttpsError('permission-denied', 'Only the host can do that.')
  if (snap.get('isActive') !== true) throw new functions.https.HttpsError('failed-precondition', 'This live has ended.')
}

/**
 * Find a PK opponent, or wait for one. A waiting host is matched with the next host who asks; both get one invite
 * (`pkInvites`, the shape the app already listens to) and must both accept.
 */
export const pkMatch = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'pkMatch', context.auth?.token)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')
    const myRef = db().collection('liveRooms').doc(roomId)
    const waiting = db().collection('liveRooms').where('pkWaiting', '==', true).where('isActive', '==', true).limit(10)
    return db().runTransaction(async (tx) => {
      const [mine, queue] = await Promise.all([tx.get(myRef), tx.get(waiting)])
      requireOwnActiveRoom(mine, uid)
      if (mine.get('pkActive') === true) throw new functions.https.HttpsError('failed-precondition', 'You are already in a PK.')
      const other = queue.docs.find((d) => d.id !== roomId && d.get('hostUid') !== uid && d.get('pkActive') !== true)
      if (!other) {
        tx.update(myRef, { pkWaiting: true })
        return { queued: true, inviteId: '' }
      }
      const inviteRef = db().collection('pkInvites').doc()
      tx.set(inviteRef, {
        hostAUid: uid,
        hostAName: String(mine.get('hostName') ?? ''),
        hostAPhotoUrl: String(mine.get('hostPhotoUrl') ?? ''),
        hostARoomId: roomId,
        hostBUid: String(other.get('hostUid') ?? ''),
        hostBName: String(other.get('hostName') ?? ''),
        hostBPhotoUrl: String(other.get('hostPhotoUrl') ?? ''),
        hostBRoomId: other.id,
        participants: [uid, String(other.get('hostUid') ?? '')],
        hostAAccepted: false,
        hostBAccepted: false,
        status: 'pending',
        createdAt: Date.now(),
      })
      tx.update(myRef, { pkWaiting: false })
      tx.update(other.ref, { pkWaiting: false })
      return { queued: false, inviteId: inviteRef.id }
    })
  })

/** Accept or decline a PK invite. The second acceptance starts the battle on both rooms, with the server's clock. */
export const pkRespond = functions
  .region('asia-south1')
  .https.onCall(async (data: { inviteId?: string; accept?: boolean }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'pkRespond', context.auth?.token)
    const inviteId = String(data?.inviteId ?? '')
    if (!inviteId) throw new functions.https.HttpsError('invalid-argument', 'inviteId is required.')
    const inviteRef = db().collection('pkInvites').doc(inviteId)
    return db().runTransaction(async (tx) => {
      const inv = await tx.get(inviteRef)
      if (!inv.exists) throw new functions.https.HttpsError('not-found', 'That PK invite is gone.')
      const participants = (inv.get('participants') ?? []) as string[]
      if (!participants.includes(uid)) throw new functions.https.HttpsError('permission-denied', 'Not your PK invite.')
      if (inv.get('status') !== 'pending') return { status: String(inv.get('status') ?? '') }
      const aRef = db().collection('liveRooms').doc(String(inv.get('hostARoomId') ?? ''))
      const bRef = db().collection('liveRooms').doc(String(inv.get('hostBRoomId') ?? ''))
      const [a, b] = await Promise.all([tx.get(aRef), tx.get(bRef)])
      if (data?.accept !== true) {
        tx.update(inviteRef, { status: 'rejected', respondedBy: uid })
        return { status: 'rejected' }
      }
      const iAmA = inv.get('hostAUid') === uid
      const accepted = {
        hostAAccepted: iAmA ? true : inv.get('hostAAccepted') === true,
        hostBAccepted: iAmA ? inv.get('hostBAccepted') === true : true,
      }
      if (!(accepted.hostAAccepted && accepted.hostBAccepted)) {
        tx.update(inviteRef, accepted)
        return { status: 'waiting' }
      }
      const bothLive = a.exists && b.exists && a.get('isActive') === true && b.get('isActive') === true
      const eitherBusy = a.get('pkActive') === true || b.get('pkActive') === true
      if (!bothLive || eitherBusy) {
        tx.update(inviteRef, { ...accepted, status: 'cancelled' })
        return { status: 'cancelled' }
      }
      const pkEndTime = Date.now() + PK_DURATION_MS
      const pkChannelId = `pk_${aRef.id}_${bRef.id}`
      const base = { pkWaiting: false, pkActive: true, pkScore: 0, pkPartnerScore: 0, pkEndTime, pkChannelId, pkInviteId: inviteId }
      tx.update(aRef, {
        ...base, pkPartnerId: bRef.id, pkPartnerUid: String(b.get('hostUid') ?? ''),
        pkPartnerName: String(b.get('hostName') ?? ''), pkPartnerPhotoUrl: String(b.get('hostPhotoUrl') ?? ''),
      })
      tx.update(bRef, {
        ...base, pkPartnerId: aRef.id, pkPartnerUid: String(a.get('hostUid') ?? ''),
        pkPartnerName: String(a.get('hostName') ?? ''), pkPartnerPhotoUrl: String(a.get('hostPhotoUrl') ?? ''),
      })
      tx.update(inviteRef, { ...accepted, status: 'started', startedAtMs: Date.now(), pkEndTime })
      return { status: 'started', pkEndTime }
    })
  })

/**
 * End a PK on both rooms and record the result: on the invite (`status: 'ended'`, scores, winner) and on each room
 * (`lastPk`) so both hosts' screens and their viewers see the same verdict.
 */
export async function endPk(roomId: string, reason: string, nowMs: Millis = Date.now()): Promise<boolean> {
  const myRef = db().collection('liveRooms').doc(roomId)
  return db().runTransaction(async (tx) => {
    const mine = await tx.get(myRef)
    if (!mine.exists || mine.get('pkActive') !== true) return false
    const partnerId = String(mine.get('pkPartnerId') ?? '')
    const partnerRef = partnerId ? db().collection('liveRooms').doc(partnerId) : null
    const inviteId = String(mine.get('pkInviteId') ?? '')
    const inviteRef = inviteId ? db().collection('pkInvites').doc(inviteId) : null
    const [partner, invite] = await Promise.all([
      partnerRef ? tx.get(partnerRef) : Promise.resolve(null),
      inviteRef ? tx.get(inviteRef) : Promise.resolve(null),
    ])
    const myScore = Number(mine.get('pkScore') ?? 0) || 0
    const partnerScore = partner?.exists ? Number(partner.get('pkScore') ?? 0) || 0 : Number(mine.get('pkPartnerScore') ?? 0) || 0
    const w = pkWinner(myScore, partnerScore)
    const myUid = String(mine.get('hostUid') ?? '')
    const partnerUid = String(mine.get('pkPartnerUid') ?? '')
    const winnerUid = w === 'A' ? myUid : w === 'B' ? partnerUid : ''
    tx.update(myRef, { ...PK_CLEAR, lastPk: { winnerUid, myScore, partnerScore, reason, endedAtMs: nowMs } })
    if (partnerRef && partner?.exists && partner.get('pkPartnerId') === roomId) {
      tx.update(partnerRef, { ...PK_CLEAR, lastPk: { winnerUid, myScore: partnerScore, partnerScore: myScore, reason, endedAtMs: nowMs } })
    }
    if (inviteRef && invite?.exists) {
      const aIsMe = invite.get('hostARoomId') === roomId
      tx.update(inviteRef, {
        status: 'ended',
        result: {
          winnerUid,
          hostAScore: aIsMe ? myScore : partnerScore,
          hostBScore: aIsMe ? partnerScore : myScore,
          reason,
          endedAtMs: nowMs,
        },
      })
    }
    return true
  })
}

/** Either host ends the PK early (or the app's timer reached zero). */
export const pkEnd = functions
  .region('asia-south1')
  .https.onCall(async (data: { roomId?: string }, context) => {
    const uid = requireAuth(context)
    await assertActiveSession(uid, data, 'pkEnd', context.auth?.token)
    const roomId = String(data?.roomId ?? '')
    if (!roomId) throw new functions.https.HttpsError('invalid-argument', 'roomId is required.')
    const snap = await db().collection('liveRooms').doc(roomId).get()
    if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Live room not found.')
    if (snap.get('hostUid') !== uid) throw new functions.https.HttpsError('permission-denied', 'Only the host can do that.')
    const ended = await endPk(roomId, Number(snap.get('pkEndTime') ?? 0) <= Date.now() ? 'time' : 'host_ended')
    return { ended }
  })

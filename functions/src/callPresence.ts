/**
 * WP2 (Owner, 5 Nov 2026) — "all call buttons depend on the call on or off [of] that person": BUSY.
 *
 * `users/{uid}.isInCall` is projected to `publicProfiles/{uid}` (syncPublicProfile), ranks people "in a call" on Home
 * and disables the profile's Call disc — and nothing ever wrote it, so a host already on a call was rung by everybody
 * else. This keeps it from the call documents themselves: whenever a write changes whether a call is LIVE (`connected`,
 * or `ending` while the last minute settles), each of its two people is `isInCall` exactly when they still have a live
 * call. Written only when the value changes.
 *
 * Deliberately outside the money path: startCall / acceptCall / tickCall / endCall and the sweep are unchanged; this
 * only reads what they wrote. A missed trigger is repaired by the next live/ended transition of any call of that person.
 */

import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'

const db = (): admin.firestore.Firestore => admin.firestore()

/** The call statuses during which a person is on the call. */
export const LIVE_CALL_STATUSES: readonly string[] = ['connected', 'ending']

export function isLiveCallStatus(status: unknown): boolean {
  return typeof status === 'string' && LIVE_CALL_STATUSES.includes(status)
}

/** True when this write changed whether the call is live — the only writes that can change anybody's `isInCall`. */
export function presenceChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  return isLiveCallStatus(before?.status) !== isLiveCallStatus(after?.status)
}

/** Whether [uid] is on any live call, as either side. Equality filters only (no composite index needed). */
async function hasLiveCall(uid: string): Promise<boolean> {
  for (const side of ['callerId', 'receiverId']) {
    for (const status of LIVE_CALL_STATUSES) {
      const q = await db().collection('calls').where(side, '==', uid).where('status', '==', status).limit(1).get()
      if (!q.empty) return true
    }
  }
  return false
}

/** Sets `users/{uid}.isInCall` from the calls; returns the value, or null when there is no such user. */
export async function refreshInCall(uid: string): Promise<boolean | null> {
  if (!uid) return null
  const userRef = db().collection('users').doc(uid)
  const busy = await hasLiveCall(uid)
  const snap = await userRef.get()
  if (!snap.exists) return null
  if ((snap.get('isInCall') === true) !== busy) await userRef.update({ isInCall: busy })
  await mirrorToRooms(uid, String(snap.get('partyRoomId') ?? ''), busy)
  return busy
}

/**
 * Owner, 6 Nov 2026 — viewers must SEE that the person is on a call:
 *   * a live they host shows an "In Call" overlay  → `liveRooms/{id}.hostInCall`
 *   * in a party room, a seat shows a call icon      → `partyRooms/{id}/seats/{n}.inCall`
 *     and a listener's dot turns yellow              → `partyRooms/{id}/listeners/{uid}.inCall`
 * Best effort and idempotent: a failure here never touches the call or its money.
 */
export async function mirrorToRooms(uid: string, partyRoomId: string, busy: boolean): Promise<void> {
  try {
    const lives = await db().collection('liveRooms').where('hostUid', '==', uid).where('isActive', '==', true).limit(3).get()
    await Promise.all(lives.docs.filter((d) => (d.get('hostInCall') === true) !== busy).map((d) => d.ref.update({ hostInCall: busy })))
    if (partyRoomId) {
      const room = db().collection('partyRooms').doc(partyRoomId)
      const listener = await room.collection('listeners').doc(uid).get()
      if (listener.exists && (listener.get('inCall') === true) !== busy) await listener.ref.update({ inCall: busy })
      const seats = await room.collection('seats').where('uid', '==', uid).limit(3).get()
      await Promise.all(seats.docs.filter((d) => (d.get('inCall') === true) !== busy).map((d) => d.ref.update({ inCall: busy })))
    }
  } catch (e) {
    functions.logger.warn('callPresence: room mirror failed', { uid, error: String(e) })
  }
}

export const syncCallPresence = functions.region('asia-south1').firestore
  .document('calls/{callId}')
  .onWrite(async (change) => {
    const before = change.before.exists ? (change.before.data() as Record<string, unknown>) : undefined
    const after = change.after.exists ? (change.after.data() as Record<string, unknown>) : undefined
    if (!presenceChanged(before, after)) return
    const call = after ?? before ?? {}
    const uids = Array.from(new Set([String(call.callerId ?? ''), String(call.receiverId ?? '')].filter((u) => u !== '')))
    await Promise.all(uids.map((u) => refreshInCall(u)))
  })

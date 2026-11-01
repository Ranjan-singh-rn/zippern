import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { users as usersApi, type DeviceBanResult, type DeviceType } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Report {
  id: string
  reporterUid: string
  reporterName: string
  targetUid: string
  targetName: string
  targetType: 'user' | 'host'
  reason: string
  description: string
  status: 'pending' | 'reviewed' | 'actioned' | 'dismissed'
  actionTaken?: string
  reviewedBy?: string
  createdAt: Timestamp | null
}

export interface BannedDevice {
  id: string
  deviceId: string
  deviceType: 'android_id' | 'imei'
  reason: string
  bannedBy: string
  bannedAt: Timestamp | null
  isActive: boolean
  userUids: string[]
}

export interface OpsTicket {
  id: string
  title: string
  description: string
  category: 'report' | 'feedback' | 'ban' | 'other'
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: 'open' | 'in_progress' | 'resolved'
  assignedTo?: string
  createdBy: string
  createdAt: Timestamp | null
  resolvedAt?: Timestamp | null
}

export interface FeedbackTicket {
  id: string
  userId: string
  userName: string
  issueType: string
  description: string
  attachmentUrls: string[]
  status: 'open' | 'in_review' | 'resolved'
  createdAt: Timestamp | null
  occurredAt?: Timestamp | null
}

// ── Reports ──────────────────────────────────────────────────────────────────

export async function getReports(status?: string): Promise<Report[]> {
  const col = collection(db, 'reports')
  const q = status
    ? query(col, where('status', '==', status), orderBy('createdAt', 'desc'), limit(200))
    : query(col, orderBy('createdAt', 'desc'), limit(200))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Report))
}

/*
 * `reviewReport` used to live here, and it was a loaded gun with no caller.
 *
 * It wrote `status: 'actioned'` and `actionTaken` straight onto the document
 * from the browser — no audit entry, no required reason, no name against the
 * decision, and above all **no consequence**: it recorded that somebody had
 * been banned without banning them, which is the exact failure the API path
 * was built to end.
 *
 * Deciding a report is `POST /users/reports/{id}/action`
 * (`api.users.actionReport`), which carries the decision out, links the report
 * to what resulted, and audits both halves. /operations/reports already uses
 * it; this function was simply waiting for somebody to find it and reintroduce
 * the bug.
 */

// ── Banned Devices ───────────────────────────────────────────────────────────

// bannedDevices only ever grows — devices are soft-unbanned (isActive: false),
// never deleted — so this read needs a bound. The orderBy('bannedAt') was
// already here and is left as-is: the server-side writers (the API's ban and
// device-ban routes, and `barDevice` in the Functions) set bannedAt, so nothing
// is excluded. No client writes this collection any more (GOV C6).
// Callers receiving exactly BANNED_DEVICE_LIMIT rows should say so in the UI —
// older bans then exist off-list.
export const BANNED_DEVICE_LIMIT = 500

export async function getBannedDevices(max: number = BANNED_DEVICE_LIMIT): Promise<BannedDevice[]> {
  const snap = await getDocs(
    query(collection(db, 'bannedDevices'), orderBy('bannedAt', 'desc'), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as BannedDevice))
}

// ── Writing a device ban: through the API, never from this browser ──────────
//
// GOV C6 (B30). These two used to write `bannedDevices` straight from the
// browser — `setDoc` keyed by the device id, `deleteDoc` to lift — which the
// rules allowed for any ops login, `ops_member` included. That was a second,
// unaudited ban system: no reason kept, no actor the server could trust (the
// `bannedBy` uid was whatever the caller passed), no `manualBan` mark, and an
// unban that could delete a ban somebody else's decision had placed.
//
// `firestore.rules` now refuses every client write on `bannedDevices`, and the
// two functions call the audited endpoints instead — the same ones
// /operations/bans uses:
//
//   POST /users/devices/bans                     {device_id, device_type,
//                                                 reason, user_uids, manual}
//   POST /users/devices/bans/{device_id}/unban   {reason}
//
// The server still keys the document by the device id (the path the Android
// app reads: AuthRepository.getDeviceBanReason / SplashScreen →
// bannedDevices.document(deviceId)), and an unban still deletes it, because the
// app checks only that it exists. The actor is the signed-in session, so there
// is no `bannedByUid` parameter any more — a caller cannot name somebody else.
export async function banDevice(
  deviceId: string,
  deviceType: DeviceType,
  reason: string,
  userUids: string[] = [],
): Promise<DeviceBanResult> {
  return usersApi.banDevice({
    device_id: deviceId,
    device_type: deviceType,
    reason,
    user_uids: userUids,
  })
}

/** Lift a device ban. A reason is mandatory — it is what the audit log keeps. */
export async function unbanDevice(deviceId: string, reason: string): Promise<DeviceBanResult> {
  return usersApi.unbanDevice(deviceId, reason)
}

// ── Ops Tickets ──────────────────────────────────────────────────────────────

export async function getOpsTickets(): Promise<OpsTicket[]> {
  const snap = await getDocs(
    query(collection(db, 'opsTickets'), orderBy('createdAt', 'desc'), limit(200))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OpsTicket))
}

export async function createOpsTicket(data: Partial<OpsTicket>): Promise<void> {
  await addDoc(collection(db, 'opsTickets'), {
    ...data,
    createdAt: serverTimestamp(),
    status: data.status ?? 'open',
  })
}

export async function updateTicketStatus(
  id: string,
  status: string,
  assignedTo?: string
): Promise<void> {
  const updates: Record<string, unknown> = { status }
  if (assignedTo !== undefined) updates.assignedTo = assignedTo
  if (status === 'resolved') updates.resolvedAt = serverTimestamp()
  await updateDoc(doc(db, 'opsTickets', id), updates)
}

// ── Feedback Tickets ─────────────────────────────────────────────────────────

export async function getFeedbackTickets(status?: string): Promise<FeedbackTicket[]> {
  const col = collection(db, 'feedbackTickets')
  const q = status
    ? query(col, where('status', '==', status), orderBy('createdAt', 'desc'), limit(200))
    : query(col, orderBy('createdAt', 'desc'), limit(200))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as FeedbackTicket))
}

export async function updateFeedbackStatus(id: string, status: string): Promise<void> {
  await updateDoc(doc(db, 'feedbackTickets', id), { status })
}

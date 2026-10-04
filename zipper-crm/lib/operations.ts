import {
  collection,
  doc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'

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
// already here and is left as-is: both writers (banDevice below, and the Android
// app's auto-ban in AuthRepository) set bannedAt, so nothing is excluded.
// Callers receiving exactly BANNED_DEVICE_LIMIT rows should say so in the UI —
// older bans then exist off-list.
export const BANNED_DEVICE_LIMIT = 500

export async function getBannedDevices(max: number = BANNED_DEVICE_LIMIT): Promise<BannedDevice[]> {
  const snap = await getDocs(
    query(collection(db, 'bannedDevices'), orderBy('bannedAt', 'desc'), limit(max))
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as BannedDevice))
}

// IMPORTANT — the document ID *must* be the deviceId.
//
// The Android app enforces device bans by reading this exact path:
//   AuthRepository.getDeviceBanReason() → bannedDevices.document(deviceId)
//   SplashScreen                        → bannedDevices.document(deviceId)
//
// This previously used addDoc(), which generates a random document ID, so the
// app's lookup never found CRM-issued bans and **no ban created from the CRM was
// ever enforced**. setDoc keyed by deviceId fixes that, and additionally makes
// re-banning the same device idempotent instead of creating duplicate rows.
export async function banDevice(
  deviceId: string,
  deviceType: string,
  reason: string,
  userUids: string[],
  bannedByUid: string
): Promise<void> {
  await setDoc(doc(db, 'bannedDevices', deviceId), {
    deviceId,
    deviceType,
    reason,
    userUids,
    bannedBy: bannedByUid,
    bannedAt: serverTimestamp(),
    isActive: true,
  })
}

// Unban deletes the document rather than setting isActive: false.
//
// Both Android read paths check only `snap.exists()` — they do not read
// isActive. A soft-unban therefore left the device permanently locked out of
// the app with no way to restore access, which is a far worse outcome than
// losing the ban row. Removing the document is what actually restores access
// against the app as it ships today.
//
// Follow-up for the Android phase: have the app check `isActive == true` as
// well, at which point this can go back to a soft-unban and retain history.
export async function unbanDevice(deviceId: string): Promise<void> {
  await deleteDoc(doc(db, 'bannedDevices', deviceId))
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

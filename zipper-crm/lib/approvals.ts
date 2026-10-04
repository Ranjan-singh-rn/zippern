import { db } from '@/lib/firebase'
import {
  collection, addDoc, getDocs, getDoc, getCountFromServer, doc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, Timestamp,
} from 'firebase/firestore'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApprovalType =
  // Agency actions
  | 'create_agency'
  | 'approve_agency' | 'reject_agency' | 'update_agency'
  | 'deactivate_agency' | 'reactivate_agency' | 'set_commission_rate'
  | 'mark_commission_paid'
  // Seller actions
  | 'create_seller'
  | 'approve_seller' | 'reject_seller' | 'update_seller'
  | 'deactivate_seller' | 'reactivate_seller'
  // Team actions
  | 'create_crm_user' | 'update_crm_user' | 'deactivate_crm_user'
  // Host actions
  | 'add_host' | 'remove_host'
  // Finance actions
  | 'credit_beans' | 'debit_beans' | 'credit_diamonds' | 'debit_diamonds'
  | 'lend_diamonds'
  // Config actions
  | 'update_config' | 'update_gifts_config'

export interface ApprovalRequest {
  id: string
  type: ApprovalType
  description: string      // human-readable summary
  targetLabel: string      // e.g. "Agency: Zipper North"
  targetCollection: string
  targetDocId: string
  operation: 'update' | 'create' | 'delete' | 'custom'
  payload: Record<string, unknown>
  // Who requested
  requestedBy: { uid: string; name: string; role: string }
  requestedAt: Timestamp
  // Review
  status: 'pending' | 'approved' | 'rejected'
  reviewedBy?: { uid: string; name: string }
  reviewedAt?: Timestamp
  reviewNotes?: string
  appliedAt?: Timestamp
}

// ── Submit an approval request ────────────────────────────────────────────────

/**
 * Approval types `onApprovalApproved` refuses outright.
 *
 * A host application has two status fields and this queue wrote only one, with
 * no reason and nobody named — so it could read approved here and pending on
 * every other screen. The decision moved to /kyc, which writes both together.
 *
 * Exported because the list page, the detail page and `submitApproval` all need
 * the same answer, and three copies of one string is how they drift apart.
 */
export const HOST_DECISION_TYPES: string[] = ['add_host']

export async function submitApproval(params: {
  type: ApprovalType
  description: string
  targetLabel: string
  targetCollection: string
  targetDocId: string
  operation: ApprovalRequest['operation']
  payload: Record<string, unknown>
  requestedBy: { uid: string; name: string; role: string }
}): Promise<string> {
  const ref = await addDoc(collection(db, 'approvalRequests'), {
    ...params,
    status: 'pending',
    requestedAt: serverTimestamp(),
  })
  return ref.id
}

// ── Fetch all pending approvals (superadmin) ──────────────────────────────────

export async function getPendingApprovals(limitTo = 200): Promise<ApprovalRequest[]> {
  const snap = await getDocs(
    query(
      collection(db, 'approvalRequests'),
      where('status', '==', 'pending'),
      orderBy('requestedAt', 'desc'),
      limit(limitTo)
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as ApprovalRequest))
}

/**
 * `limitTo` is applied by Firestore, not by JavaScript. It used to download the
 * entire `approvalRequests` collection and then `.slice()` — so the parameter
 * cost nothing to ignore and everything to read.
 */
export async function getAllApprovals(limitTo = 100): Promise<ApprovalRequest[]> {
  const snap = await getDocs(
    query(collection(db, 'approvalRequests'), orderBy('requestedAt', 'desc'), limit(limitTo))
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as ApprovalRequest))
}

export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  const snap = await getDoc(doc(db, 'approvalRequests', id))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as ApprovalRequest
}

// ── Superadmin: approve ───────────────────────────────────────────────────────

export async function approveRequest(
  id: string,
  reviewer: { uid: string; name: string },
  notes = ''
): Promise<void> {
  await updateDoc(doc(db, 'approvalRequests', id), {
    status: 'approved',
    reviewedBy: reviewer,
    reviewedAt: serverTimestamp(),
    reviewNotes: notes,
  })
  // Cloud Function onApprovalApproved picks this up and applies the change
}

// ── Superadmin: reject ────────────────────────────────────────────────────────

export async function rejectRequest(
  id: string,
  reviewer: { uid: string; name: string },
  notes: string
): Promise<void> {
  await updateDoc(doc(db, 'approvalRequests', id), {
    status: 'rejected',
    reviewedBy: reviewer,
    reviewedAt: serverTimestamp(),
    reviewNotes: notes,
  })
}

// ── Count pending (for badge) ─────────────────────────────────────────────────

export async function countPendingApprovals(): Promise<number> {
  // Server-side aggregation — returns the count without downloading any docs.
  const snap = await getCountFromServer(
    query(collection(db, 'approvalRequests'), where('status', '==', 'pending'))
  )
  return snap.data().count
}

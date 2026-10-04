import { db } from '@/lib/firebase'
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
  increment,
  Timestamp,
} from 'firebase/firestore'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface Policy {
  docType: string
  content: string
  version: number
  lastUpdatedBy: string
  lastUpdatedByName: string
  updatedAt: Timestamp
  publishedAt?: Timestamp
  isPublished: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function getPolicy(docType: string): Promise<Policy | null> {
  const snap = await getDoc(doc(db, 'policies', docType))
  if (!snap.exists()) return null
  return snap.data() as Policy
}

export async function updatePolicy(
  docType: string,
  content: string,
  updatedByUid: string,
  updatedByName: string
): Promise<void> {
  const ref = doc(db, 'policies', docType)
  const snap = await getDoc(ref)

  if (!snap.exists()) {
    // Create initial doc
    await setDoc(ref, {
      docType,
      content,
      version: 1,
      lastUpdatedBy: updatedByUid,
      lastUpdatedByName: updatedByName,
      updatedAt: serverTimestamp(),
      isPublished: false,
    })
  } else {
    await updateDoc(ref, {
      content,
      version: increment(1),
      lastUpdatedBy: updatedByUid,
      lastUpdatedByName: updatedByName,
      updatedAt: serverTimestamp(),
    })
  }
}

export async function publishPolicy(docType: string): Promise<void> {
  await updateDoc(doc(db, 'policies', docType), {
    isPublished: true,
    publishedAt: serverTimestamp(),
  })
}

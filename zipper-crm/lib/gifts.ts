import { db } from '@/lib/firebase'
import {
  collection, getDocs, doc, addDoc, updateDoc, deleteDoc,
  query, orderBy, Timestamp, serverTimestamp,
} from 'firebase/firestore'

// ── Earning Rate Rules ─────────────────────────────────────────────────────
//
//  normal:    Host earns 50% of diamond cost as beans (fixed)
//  exclusive: Host earns 50–55% (set per gift in CRM)
//  lucky:     Host earns 5% (lucky draw mechanic — platform keeps rest for pool)
//
//  Example:
//    Normal gift 100 diamonds    → host earns 50 beans
//    Exclusive gift 100 diamonds → host earns 50–55 beans
//    Lucky gift 100 diamonds     → host earns 5 beans

export const CATEGORY_DEFAULT_RATES: Record<Gift['category'], number> = {
  normal:    50,
  exclusive: 50,
  lucky:      5,
}

export const CATEGORY_RATE_RANGES: Record<Gift['category'], [number, number]> = {
  normal:    [50, 50],  // fixed, not editable
  exclusive: [50, 55],  // configurable per gift
  lucky:     [5,  5],   // fixed, not editable
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Gift {
  id: string
  name: string
  emoji: string
  imageUrl?: string          // Firebase Storage URL for the gift thumbnail shown in-app grid
  lottieAsset?: string       // Bundled asset path ("gifts/g1_rose.json") OR remote Lottie URL
  diamondCost: number
  // earningRate: % of diamondCost that host earns as beans
  // beanValue = floor(diamondCost * earningRate / 100)
  earningRate: number
  category: 'normal' | 'exclusive' | 'lucky'
  isActive: boolean
  sortOrder: number
  totalSent?: number
  createdAt?: Timestamp | null
}

export function computeBeanValue(diamondCost: number, earningRate: number): number {
  return Math.floor(diamondCost * (earningRate / 100))
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function getGifts(): Promise<Gift[]> {
  const snap = await getDocs(query(collection(db, 'gifts'), orderBy('sortOrder', 'asc')))
  return snap.docs.map(d => {
    const data = d.data()
    // Back-compat: old docs may have used beanValue instead of earningRate
    const earningRate = data.earningRate ??
      (data.beanValue && data.diamondCost
        ? Math.round((data.beanValue / data.diamondCost) * 100)
        : CATEGORY_DEFAULT_RATES[data.category as Gift['category']] ?? 50)
    return { id: d.id, ...data, earningRate } as Gift
  })
}

export async function createGift(data: Omit<Gift, 'id' | 'createdAt'>): Promise<string> {
  const ref = await addDoc(collection(db, 'gifts'), {
    name:        data.name,
    emoji:       data.emoji,
    imageUrl:    data.imageUrl    ?? '',
    lottieAsset: data.lottieAsset ?? '',
    diamondCost: data.diamondCost,
    earningRate: data.earningRate,
    category:    data.category,
    isActive:    data.isActive,
    sortOrder:   data.sortOrder,
    createdAt:   serverTimestamp(),
  })
  return ref.id
}

export async function updateGift(id: string, data: Partial<Omit<Gift, 'id' | 'createdAt'>>): Promise<void> {
  await updateDoc(doc(db, 'gifts', id), { ...data, updatedAt: serverTimestamp() })
}

export async function deleteGift(id: string): Promise<void> {
  await deleteDoc(doc(db, 'gifts', id))
}

export async function toggleGiftActive(id: string, isActive: boolean): Promise<void> {
  await updateDoc(doc(db, 'gifts', id), { isActive })
}


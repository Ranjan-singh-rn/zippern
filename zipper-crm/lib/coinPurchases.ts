import { db } from '@/lib/firebase'
import {
  collection,
  getDocs,
  doc,
  updateDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore'

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface CoinPurchaseRequest {
  id: string
  sellerUid: string
  sellerName: string
  sellerEmail: string
  coinsRequested: number         // e.g. 100000 (1 lakh)
  paymentMethod: 'bank' | 'binance'
  amountPaid: number             // as recorded on the request, in whole INR or USD
  currency: 'INR' | 'USD'
  paymentProofUrl: string
  transactionRef?: string        // UTR number (bank) or Binance TxID
  status: 'pending' | 'approved' | 'rejected'
  rejectedReason?: string
  approvedBy?: string
  approvedAt?: Timestamp
  createdAt: Timestamp
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `PAYMENT_CONFIG`
 *
 * WHAT WAS HERE
 *   A named individual's HDFC current account number, its IFSC, the branch
 *   address, and a Binance UID — as a plain exported const in a module that is
 *   imported by the browser. Anything in `lib/` ends up in the client bundle,
 *   so those bank details were being served, in cleartext, to every visitor who
 *   loaded the CRM, signed in or not. It had zero importers, so it was leaking
 *   without even being used.
 *
 * WHY IT IS GONE, AND STAYS GONE
 *   Company payment instruments are owner-only. They belong server-side,
 *   released by an authenticated endpoint to the specific person who needs to
 *   pay, and never compiled into a JavaScript bundle. If a screen needs to show
 *   a seller where to send money, that comes from the API against their session
 *   — it is not a constant.
 *
 *   Whoever needs the account details: rotate them. They were public.
 *
 *   It also carried a third copy of the price table (₹2,290 / $28 per lakh)
 *   which disagreed with `lib/rates.ts` (₹2,390) and with the backend. Rates
 *   come from `lib/rates.ts` — `getRates()` / `ratesNow()` — only.
 *
 * DELETED — `COIN_PACKAGES`
 *   Zero importers; a fourth copy of the same stale price table. Packages and
 *   prices belong to the API, which is what actually prices a purchase.
 * ───────────────────────────────────────────────────────────────────────────── */

// ── Firestore Helpers ─────────────────────────────────────────────────────────

/**
 * Audit C-15: every list read here is bounded. A screen that shows one of
 * these says "showing the first N" when `length === COIN_PURCHASE_LIST_LIMIT`.
 */
export const COIN_PURCHASE_LIST_LIMIT = 200

export async function getCoinPurchaseRequests(
  status?: string,
  max: number = COIN_PURCHASE_LIST_LIMIT,
): Promise<CoinPurchaseRequest[]> {
  const q = status
    ? query(
        collection(db, 'coinPurchaseRequests'),
        where('status', '==', status),
        orderBy('createdAt', 'desc'),
        limit(max),
      )
    : query(collection(db, 'coinPurchaseRequests'), orderBy('createdAt', 'desc'), limit(max))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as CoinPurchaseRequest))
}

export async function getSellerCoinPurchases(
  sellerUid: string,
  max: number = COIN_PURCHASE_LIST_LIMIT,
): Promise<CoinPurchaseRequest[]> {
  const snap = await getDocs(
    query(
      collection(db, 'coinPurchaseRequests'),
      where('sellerUid', '==', sellerUid),
      orderBy('createdAt', 'desc'),
      limit(max),
    )
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as CoinPurchaseRequest))
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `approveCoinPurchase`
 *
 * WHAT WAS HERE
 *   updateDoc(sellers/{uid}, { coinBalance: increment(coinsRequested) }) —
 *   inventory credited straight from the browser on one person's say-so, with
 *   no second pair of eyes on the payment proof and no check that the UTR had
 *   not already been used for an earlier purchase.
 *
 * WHY IT IS GONE
 *   Zero importers. `firestore.rules` now refuses browser writes to
 *   `coinBalance`, so it would have thrown permission-denied anyway.
 *
 * WHAT REPLACES IT
 *   api.partnerOps.checkPaymentRef(ref) to catch a reused UTR first, then
 *   api.partnerOps.requestCoinPurchase(sellerId, {
 *     coins, amount_paid_minor, payment_ref, evidence_url?, reason })
 *     → POST /api/partner-ops/sellers/{id}/coin-purchases
 *   That raises a card; the balance moves server-side after signature.
 *
 * `rejectCoinPurchase` below is kept: it moves no money, it only closes a
 * request document with a reason.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function rejectCoinPurchase(
  reqId: string,
  reason: string,
  approvedByUid: string
): Promise<void> {
  await updateDoc(doc(db, 'coinPurchaseRequests', reqId), {
    status: 'rejected',
    rejectedReason: reason,
    approvedBy: approvedByUid,
    approvedAt: serverTimestamp(),
  })
}

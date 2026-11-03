/**
 * PRIVATE PARTY ROOMS — the paid subscription (B7, 3 Nov 2026).
 *
 * The owner's rule: a user who has reached level 7 may subscribe to private-room functionality for ₹200 a month.
 * Zipper's money in the app is diamonds (bought with rupees through recharge), so the subscription is paid in
 * diamonds — the price is the Owner's ₹ amount at the economy's diamond price (`appConfig/economy.
 * diamondPackPriceInr`, ₹ per lakh diamonds), or a diamond price the Owner sets outright. The SERVER takes the
 * diamonds, in the same transaction that extends the entitlement: there is no "the app says I paid".
 *
 *   partySubscriptions/{uid}   { expiresAtMs, startedAtMs, autoRenew, renewals, lastPriceDiamonds, … }  (the owner reads)
 *   subscriptionPayments/{id}  one row per payment (server-only; the CRM reads through the API)
 *   platformRevenue/{id}       type 'subscription' — the whole price is Zipper's
 *
 * Entitlement: `expiresAtMs > now`. Cancelling turns renewal off; access lasts to the end of the period paid for.
 * Renewal: daily at 01:00 IST, for subscriptions that renew and end within a day — paid from the wallet; if the
 * wallet is short, the attempt is recorded and the subscription simply ends at its expiry.
 *
 * Settings: `appConfig/partySubscription` (Owner-only write): enabled, required (private rooms need it), priceInr,
 * priceDiamonds (0 = from the economy), minLevel, days.
 */

import * as admin from 'firebase-admin'
import * as functions from 'firebase-functions'
import { assertActiveSession, restrictionVerdict, ACCOUNT_RESTRICTED } from './mobileSession'

const REGION = 'asia-south1'
const DAY_MS = 86_400_000
const db = () => admin.firestore()
const inc = (n: number) => admin.firestore.FieldValue.increment(n)
const now = () => admin.firestore.FieldValue.serverTimestamp()

export const SUBSCRIPTION_REQUIRED = 'PRIVATE_ROOM_SUBSCRIPTION_REQUIRED'
export const FALLBACK_DIAMOND_PER_LAKH_INR = 2390

export interface SubConfig {
  enabled: boolean
  required: boolean
  priceInr: number
  priceDiamonds: number
  minLevel: number
  days: number
}

export function mergeSubConfig(raw: Record<string, unknown> | undefined): SubConfig {
  const r = raw ?? {}
  const n = (v: unknown, d: number, lo: number, hi: number) => {
    const x = Number(v)
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
  }
  return {
    enabled: r.enabled !== false,
    required: r.required !== false,
    priceInr: n(r.priceInr, 200, 1, 100_000),
    priceDiamonds: Math.trunc(n(r.priceDiamonds, 0, 0, 100_000_000)),
    minLevel: Math.trunc(n(r.minLevel, 7, 0, 100)),
    days: Math.trunc(n(r.days, 30, 1, 366)),
  }
}

/** The price in diamonds: the Owner's diamond price if set, else ₹ price at the economy's diamond price, rounded up. */
export function priceInDiamonds(cfg: SubConfig, economy: Record<string, unknown> | undefined): number {
  if (cfg.priceDiamonds > 0) return cfg.priceDiamonds
  const perLakh = Number(economy?.diamondPackPriceInr)
  const rupeesPerDiamond = (Number.isFinite(perLakh) && perLakh > 0 ? perLakh : FALLBACK_DIAMOND_PER_LAKH_INR) / 100_000
  return Math.ceil(cfg.priceInr / rupeesPerDiamond - 1e-9)
}

export function hasEntitlement(sub: Record<string, unknown> | undefined, nowMs: number): boolean {
  return !!sub && sub.revoked !== true && Number(sub.expiresAtMs ?? 0) > nowMs
}

/** A new period starts when the old one ends (or now, if it has already ended). */
export function nextExpiry(currentExpiresAtMs: number, nowMs: number, days: number): number {
  return Math.max(currentExpiresAtMs || 0, nowMs) + days * DAY_MS
}

const subRef = (uid: string) => db().collection('partySubscriptions').doc(uid)
const cfgRef = () => db().collection('appConfig').doc('partySubscription')
const economyRef = () => db().collection('appConfig').doc('economy')
const idemRef = (uid: string, key: string) => db().collection('subscriptionIdempotency').doc(`${uid}_${key}`)

function requireAuth(context: functions.https.CallableContext): string {
  const uid = context.auth?.uid
  if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  return uid
}

/** Whether `uid` may open a private room now — read by createPartyRoom. */
export async function privateRoomGate(uid: string, level: number): Promise<void> {
  const [cfgSnap, subSnap] = await Promise.all([cfgRef().get(), subRef(uid).get()])
  const cfg = mergeSubConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
  if (!cfg.enabled || !cfg.required) return
  if (hasEntitlement(subSnap.exists ? (subSnap.data() as Record<string, unknown>) : undefined, Date.now())) return
  throw new functions.https.HttpsError(
    'failed-precondition',
    level >= cfg.minLevel
      ? 'Private rooms are part of Party Pro. Subscribe to open one.'
      : `Private rooms unlock at level ${cfg.minLevel}. You are level ${level}.`,
    { code: SUBSCRIPTION_REQUIRED, minLevel: cfg.minLevel, level },
  )
}

export const privateRoomSubscriptionStatus = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context)
  const [cfgSnap, ecoSnap, userSnap, subSnap] = await Promise.all([cfgRef().get(), economyRef().get(), db().collection('users').doc(uid).get(), subRef(uid).get()])
  const cfg = mergeSubConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
  const sub = subSnap.exists ? (subSnap.data() as Record<string, unknown>) : undefined
  const level = Number(userSnap.get('level') ?? 0) || 0
  return {
    enabled: cfg.enabled, required: cfg.required, minLevel: cfg.minLevel, level, eligible: level >= cfg.minLevel,
    priceInr: cfg.priceInr, priceDiamonds: priceInDiamonds(cfg, ecoSnap.exists ? (ecoSnap.data() as Record<string, unknown>) : undefined),
    days: cfg.days, active: hasEntitlement(sub, Date.now()), expiresAtMs: Number(sub?.expiresAtMs ?? 0),
    autoRenew: sub?.autoRenew === true, diamonds: Number(userSnap.get('diamonds') ?? 0) || 0,
  }
})

/** Pay one period from the wallet, inside `tx` (everything read already). Returns the new expiry. */
function payPeriod(
  tx: admin.firestore.Transaction, uid: string, userSnap: admin.firestore.DocumentSnapshot,
  sub: Record<string, unknown> | undefined, cfg: SubConfig, price: number, nowMs: number, kind: 'new' | 'renewal',
): number {
  const before = Number(userSnap.get('diamonds') ?? 0) || 0
  if (before < price) {
    throw new functions.https.HttpsError('failed-precondition', `Party Pro costs ${price} diamonds. You have ${before}.`,
      { code: 'INSUFFICIENT_DIAMONDS', needed: price, have: before })
  }
  const expiresAtMs = nextExpiry(Number(sub?.expiresAtMs ?? 0), nowMs, cfg.days)
  const n = (Number(sub?.renewals ?? 0) || 0) + 1
  const payId = `${uid}_${n}`
  const userRef = db().collection('users').doc(uid)
  tx.update(userRef, { diamonds: inc(-price), totalGemsSpent: inc(price) })
  tx.set(userRef.collection('diamondTransactions').doc(`sub_${payId}`), {
    type: 'debit', amount: price, balanceAfter: before - price, reason: 'party_pro_subscription',
    reasonLabel: `Party Pro — ${cfg.days} days`, context: 'subscription', timestamp: now(),
  })
  tx.set(db().collection('subscriptionPayments').doc(payId), {
    uid, kind, diamonds: price, priceInr: cfg.priceInr, periodStartMs: Math.max(Number(sub?.expiresAtMs ?? 0) || 0, nowMs),
    periodEndMs: expiresAtMs, createdAt: now(),
  })
  tx.set(db().collection('platformRevenue').doc(`sub_${payId}`), {
    type: 'subscription', subType: 'party_pro', grossDiamonds: price, payoutBeans: 0, platformCut: price, senderUid: uid,
    timestamp: now(),
  })
  tx.set(subRef(uid), {
    uid, expiresAtMs, autoRenew: true, renewals: n, lastPriceDiamonds: price, lastPaymentAtMs: nowMs,
    ...(sub?.startedAtMs ? {} : { startedAtMs: nowMs }), renewalFailedAtMs: admin.firestore.FieldValue.delete(), updatedAt: now(),
  }, { merge: true })
  return expiresAtMs
}

export const subscribePrivateRooms = functions.region(REGION).https.onCall(async (data: { idempotencyKey?: string }, context) => {
  const uid = requireAuth(context)
  await assertActiveSession(uid, data, 'subscribePrivateRooms', context.auth?.token)
  const key = String(data?.idempotencyKey ?? '').trim()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new functions.https.HttpsError('invalid-argument', 'This request could not be read. Update the app and try again.')
  const nowMs = Date.now()
  return db().runTransaction(async (tx) => {
    const [idem, cfgSnap, ecoSnap, userSnap, subSnap] = await Promise.all([
      tx.get(idemRef(uid, key)), tx.get(cfgRef()), tx.get(economyRef()), tx.get(db().collection('users').doc(uid)), tx.get(subRef(uid)),
    ])
    if (idem.exists) return { ...idem.data(), replayed: true }
    const cfg = mergeSubConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
    if (!cfg.enabled) throw new functions.https.HttpsError('failed-precondition', 'Party Pro is not available right now.')
    if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Finish setting up your profile first.')
    const restricted = restrictionVerdict((f) => userSnap.get(f))
    if (restricted) throw new functions.https.HttpsError('permission-denied', 'This account cannot subscribe right now.', { code: ACCOUNT_RESTRICTED, state: restricted })
    const level = Number(userSnap.get('level') ?? 0) || 0
    if (level < cfg.minLevel) {
      throw new functions.https.HttpsError('failed-precondition', `Party Pro unlocks at level ${cfg.minLevel}. You are level ${level}.`,
        { code: 'LEVEL_TOO_LOW', minLevel: cfg.minLevel, level })
    }
    const price = priceInDiamonds(cfg, ecoSnap.exists ? (ecoSnap.data() as Record<string, unknown>) : undefined)
    const sub = subSnap.exists ? (subSnap.data() as Record<string, unknown>) : undefined
    const expiresAtMs = payPeriod(tx, uid, userSnap, sub, cfg, price, nowMs, hasEntitlement(sub, nowMs) ? 'renewal' : 'new')
    const result = { active: true, expiresAtMs, priceDiamonds: price, autoRenew: true, replayed: false }
    tx.set(idemRef(uid, key), { ...result, createdAt: now() })
    return result
  })
})

/** Turn renewal off. Access lasts to the end of the period already paid for. */
export const cancelPrivateRoomSubscription = functions.region(REGION).https.onCall(async (_data, context) => {
  const uid = requireAuth(context)
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(subRef(uid))
    if (!snap.exists) return { autoRenew: false, expiresAtMs: 0 }
    tx.set(subRef(uid), { autoRenew: false, cancelledAtMs: Date.now(), updatedAt: now() }, { merge: true })
    return { autoRenew: false, expiresAtMs: Number(snap.get('expiresAtMs') ?? 0) }
  })
})

/** One renewal pass: subscriptions that renew and end within a day are paid from the wallet. Exported for tests. */
export async function renewPrivateRoomSubscriptionsOnce(nowMs: number): Promise<{ renewed: number; failed: number }> {
  const due = await db().collection('partySubscriptions')
    .where('autoRenew', '==', true).where('expiresAtMs', '<', nowMs + DAY_MS).limit(200).get()
  let renewed = 0
  let failed = 0
  for (const d of due.docs) {
    const ok = await db().runTransaction(async (tx) => {
      const [cfgSnap, ecoSnap, userSnap, subSnap] = await Promise.all([
        tx.get(cfgRef()), tx.get(economyRef()), tx.get(db().collection('users').doc(d.id)), tx.get(subRef(d.id)),
      ])
      const sub = subSnap.data() as Record<string, unknown> | undefined
      if (!sub || sub.autoRenew !== true || Number(sub.expiresAtMs ?? 0) >= nowMs + DAY_MS) return 'skip' as const
      const cfg = mergeSubConfig(cfgSnap.exists ? (cfgSnap.data() as Record<string, unknown>) : undefined)
      const price = priceInDiamonds(cfg, ecoSnap.exists ? (ecoSnap.data() as Record<string, unknown>) : undefined)
      const level = Number(userSnap.get('level') ?? 0) || 0
      const blocked = !cfg.enabled || !userSnap.exists || level < cfg.minLevel || !!restrictionVerdict((f) => userSnap.get(f))
      if (blocked || (Number(userSnap.get('diamonds') ?? 0) || 0) < price) {
        tx.set(subRef(d.id), { renewalFailedAtMs: nowMs, renewalFailure: blocked ? 'not_eligible' : 'insufficient_diamonds', updatedAt: now() }, { merge: true })
        return 'failed' as const
      }
      payPeriod(tx, d.id, userSnap, sub, cfg, price, nowMs, 'renewal')
      return 'renewed' as const
    })
    if (ok === 'renewed') renewed++
    if (ok === 'failed') failed++
  }
  return { renewed, failed }
}

export const renewPrivateRoomSubscriptions = functions.region(REGION).pubsub.schedule('0 1 * * *').timeZone('Asia/Kolkata')
  .onRun(async () => {
    const r = await renewPrivateRoomSubscriptionsOnce(Date.now())
    if (r.renewed || r.failed) functions.logger.info(`renewPrivateRoomSubscriptions: ${r.renewed} renewed, ${r.failed} not renewed`)
    return null
  })

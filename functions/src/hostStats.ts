import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import { istDateKey, istWeekKey } from './time'

const db = admin.firestore()

/**
 * What a host sees about their own day, and the level ladder they climb.
 *
 * ── Why per-day documents and not counters on the user ───────────────────────
 *
 * Host Home shows "today": beans earned, minutes live, calls taken. The obvious
 * implementation is `beansToday` on the user document plus a job that zeroes it
 * at midnight. That job is the problem — if it fails, or runs late, or runs
 * twice, a host's day either never ends or vanishes, and both are visible to
 * them immediately.
 *
 * `users/{uid}/dailyStats/{2026-09-12}` has no reset. A new day is a new
 * document. Nothing has to happen at midnight for midnight to work, and a
 * history falls out for free — which the payout statement and the CRM both
 * want anyway.
 *
 * ── Why the level is computed here and not by a trigger ──────────────────────
 *
 * A trigger on `users/{uid}` that writes `hostLevel` back onto `users/{uid}`
 * re-fires itself. It can be made to terminate, but the version that forgets to
 * is an infinite loop billed by the invocation. Level is derived from earnings,
 * earnings only change inside these transactions, so the level is set in the
 * same place — and a nightly sweep catches anything that drifted.
 */

// ── The ladder ───────────────────────────────────────────────────────────────

export interface HostLevel {
  level: number
  beansRequired: number
  maxCallRateBeans: number
}

/**
 * Used only when `levelConfig/host/levels` is empty.
 *
 * Kept in step with `scripts/seed-host-levels.mjs`, which is what writes the
 * real ladder. The rates here previously went to 12,000 beans/min — a number
 * from an earlier version of the economy that nobody had revisited, and one a
 * host would have been very pleased to discover.
 *
 * The agreed shape: a level-0 host is capped at 700, and the top of the ladder
 * allows 2,400.
 */
const FALLBACK_LADDER: HostLevel[] = [
  { level: 0, beansRequired: 0, maxCallRateBeans: 700 },
  { level: 1, beansRequired: 10_000, maxCallRateBeans: 850 },
  { level: 2, beansRequired: 100_000, maxCallRateBeans: 1_000 },
  { level: 3, beansRequired: 300_000, maxCallRateBeans: 1_150 },
  { level: 4, beansRequired: 600_000, maxCallRateBeans: 1_350 },
  { level: 5, beansRequired: 1_000_000, maxCallRateBeans: 1_550 },
  { level: 6, beansRequired: 2_000_000, maxCallRateBeans: 1_750 },
  { level: 7, beansRequired: 4_000_000, maxCallRateBeans: 1_950 },
  { level: 8, beansRequired: 8_000_000, maxCallRateBeans: 2_150 },
  { level: 9, beansRequired: 16_000_000, maxCallRateBeans: 2_300 },
  { level: 10, beansRequired: 32_000_000, maxCallRateBeans: 2_400 },
]

let ladderCache: { at: number; ladder: HostLevel[] } | null = null
const LADDER_TTL_MS = 10 * 60 * 1000

/**
 * The ladder from the CRM, cached for ten minutes.
 *
 * Cached because every gift and every call tick needs it, and eleven document
 * reads per gift would cost more than the gift. Ten minutes is the delay
 * between an operator retuning the ladder and it taking effect — acceptable for
 * a progression table, and the alternative is paying for a collection read on
 * the hot path.
 *
 * A failed read keeps the previous cache rather than falling back, so a
 * transient Firestore error cannot silently demote every host on the platform.
 */
export async function getHostLadder(): Promise<HostLevel[]> {
  const now = Date.now()
  if (ladderCache && now - ladderCache.at < LADDER_TTL_MS) return ladderCache.ladder

  try {
    const snap = await db.collection('levelConfig').doc('host').collection('levels').get()
    if (!snap.empty) {
      const ladder = snap.docs
        .map((d) => ({
          level: Number(d.get('level') ?? Number(d.id)),
          beansRequired: Number(d.get('beansRequired') ?? 0),
          maxCallRateBeans: Number(d.get('maxCallRateBeans') ?? 0),
        }))
        .filter((l) => Number.isFinite(l.level))
        .sort((a, b) => a.level - b.level)
      ladderCache = { at: now, ladder }
      return ladder
    }
  } catch (err) {
    functions.logger.warn('getHostLadder: read failed, keeping previous ladder', err)
    if (ladderCache) return ladderCache.ladder
  }

  ladderCache = { at: now, ladder: FALLBACK_LADDER }
  return FALLBACK_LADDER
}

/** Highest level whose requirement the host has met. */
export function hostLevelFor(totalBeans: number, ladder: HostLevel[]): number {
  let level = 0
  for (const rung of ladder) {
    if (totalBeans >= rung.beansRequired) level = rung.level
    else break
  }
  return level
}

// ── Accrual ──────────────────────────────────────────────────────────────────

export interface HostAccrual {
  beans?: number
  source?: 'gift' | 'call'
  /** Seconds of call time, for the "time on calls today" figure. */
  callSeconds?: number
  calls?: number
  giftsReceived?: number
}

/**
 * Record a host's activity against today.
 *
 * Called inside the same transaction that credits the beans, so the counter and
 * the balance commit together. If they could diverge, Host Home would show a
 * day's earnings that the wallet disagreed with, and the host would believe the
 * bigger number.
 *
 * `hostLevel` is passed in rather than computed here because a transaction
 * cannot read after it writes — the caller has the new total already.
 */
export function accrueHostStats(
  tx: admin.firestore.Transaction,
  userRef: admin.firestore.DocumentReference,
  a: HostAccrual,
) {
  const beans = Math.max(0, Math.floor(a.beans ?? 0))
  const seconds = Math.max(0, Math.floor(a.callSeconds ?? 0))
  const calls = Math.max(0, Math.floor(a.calls ?? 0))
  const gifts = Math.max(0, Math.floor(a.giftsReceived ?? 0))
  if (beans === 0 && seconds === 0 && calls === 0 && gifts === 0) return

  const dayKey = istDateKey()
  const inc = admin.firestore.FieldValue.increment

  const patch: Record<string, any> = {
    dayKey,
    weekKey: istWeekKey(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }
  if (beans > 0) {
    patch.beans = inc(beans)
    if (a.source) patch[`${a.source}Beans`] = inc(beans)
  }
  if (seconds > 0) patch.callSeconds = inc(seconds)
  if (calls > 0) patch.calls = inc(calls)
  if (gifts > 0) patch.giftsReceived = inc(gifts)

  tx.set(userRef.collection('dailyStats').doc(dayKey), patch, { merge: true })
}

/**
 * Set `hostLevel` if the new total has crossed a rung.
 *
 * Only writes when it changes. `hostLevel` is in the `publicProfiles`
 * projection's watch list, so an unconditional write would reproject every
 * profile on every gift.
 */
export function applyHostLevel(
  tx: admin.firestore.Transaction,
  userRef: admin.firestore.DocumentReference,
  currentLevel: number,
  newTotalBeans: number,
  ladder: HostLevel[],
) {
  const level = hostLevelFor(newTotalBeans, ladder)
  if (level !== currentLevel) {
    tx.update(userRef, { hostLevel: level })
  }
}

// ── getHostHome ──────────────────────────────────────────────────────────────

/**
 * Everything the host's home screen shows, in one call.
 *
 * One round trip on purpose. The screen was going to need today's stats, the
 * week's earnings, the level and its next rung, and the payout position — five
 * reads the app would otherwise make in parallel and render in four different
 * loading states.
 */
export const getHostHome = functions
  .region('asia-south1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const userRef = db.collection('users').doc(uid)
    const today = istDateKey()
    const weekKey = istWeekKey()

    const [userSnap, todaySnap, weekSnap, ladder] = await Promise.all([
      userRef.get(),
      userRef.collection('dailyStats').doc(today).get(),
      userRef.collection('weeklyEarnings').doc(weekKey).get(),
      getHostLadder(),
    ])

    if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')
    if (userSnap.get('isHost') !== true) {
      throw new functions.https.HttpsError('permission-denied', 'This is for hosts only.')
    }

    const callEarnings = Number(userSnap.get('hostCallEarnings') ?? 0)
    const giftEarnings = Number(userSnap.get('hostGiftEarnings') ?? 0)
    const lifetime = callEarnings + giftEarnings

    const level = hostLevelFor(lifetime, ladder)
    const current = ladder.find((l) => l.level === level) ?? ladder[0]
    const next = ladder.find((l) => l.level === level + 1) ?? null

    const verified = userSnap.get('isVerifiedHost') === true

    return {
      today: {
        dayKey: today,
        beans: Number(todaySnap.get('beans') ?? 0),
        giftBeans: Number(todaySnap.get('giftBeans') ?? 0),
        callBeans: Number(todaySnap.get('callBeans') ?? 0),
        callSeconds: Number(todaySnap.get('callSeconds') ?? 0),
        calls: Number(todaySnap.get('calls') ?? 0),
        giftsReceived: Number(todaySnap.get('giftsReceived') ?? 0),
      },
      week: {
        weekKey,
        beans: Number(weekSnap.get('beans') ?? 0),
        giftBeans: Number(weekSnap.get('giftBeans') ?? 0),
        callBeans: Number(weekSnap.get('callBeans') ?? 0),
      },
      lifetime: { beans: lifetime, callBeans: callEarnings, giftBeans: giftEarnings },
      level: {
        level,
        // What the host may charge. An unverified host is held at the base
        // rate whatever their level, which is the same rule startCall applies
        // when it prices a call — stated here so the slider agrees with the bill.
        maxCallRateBeans: verified ? current.maxCallRateBeans : 0,
        callRateBeans: Number(userSnap.get('callRateBeans') ?? 0),
        nextLevel: next?.level ?? null,
        beansToNextLevel: next ? Math.max(0, next.beansRequired - lifetime) : 0,
        nextLevelAt: next?.beansRequired ?? null,
      },
      payout: {
        beans: Number(userSnap.get('beans') ?? 0),
        beansAvailable: Number(userSnap.get('beansAvailable') ?? 0),
        isVerifiedHost: verified,
        payoutHold: userSnap.get('payoutHold') === true,
      },
    }
  })

// ── Nightly level sweep ──────────────────────────────────────────────────────

/**
 * Catch hosts whose level drifted from their earnings.
 *
 * `applyHostLevel` sets the level as earnings land, so this should find
 * nothing. It exists for the cases that bypass that path: a CRM balance
 * correction, a manual fix, a ladder an operator retuned, or a deploy that
 * happened mid-transaction.
 *
 * 02:00 IST — after the day closes, before the 07:00 reports read it.
 */
export const sweepHostLevels = functions
  .region('asia-south1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('0 2 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const ladder = await getHostLadder()
    let checked = 0
    let corrected = 0
    let cursor: admin.firestore.QueryDocumentSnapshot | null = null

    for (;;) {
      let q = db.collection('users')
        .where('isHost', '==', true)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(400)
      if (cursor) q = q.startAfter(cursor)
      const page = await q.get()
      if (page.empty) break

      const batch = db.batch()
      let writes = 0
      for (const doc of page.docs) {
        checked++
        const lifetime =
          Number(doc.get('hostCallEarnings') ?? 0) + Number(doc.get('hostGiftEarnings') ?? 0)
        const should = hostLevelFor(lifetime, ladder)
        if (Number(doc.get('hostLevel') ?? 0) !== should) {
          batch.update(doc.ref, { hostLevel: should })
          writes++
          corrected++
        }
      }
      if (writes > 0) await batch.commit()

      cursor = page.docs[page.docs.length - 1]
      if (page.size < 400) break
    }

    functions.logger.info(`sweepHostLevels: ${checked} hosts checked, ${corrected} corrected`)
    return null
  })

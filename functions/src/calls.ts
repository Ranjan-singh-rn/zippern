import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https'
// The watchdog stays gen-1: it is a cron, and nobody waits on a cron.
import * as functions from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import * as admin from 'firebase-admin'

/**
 * ── Gen-2, with a warm instance ──────────────────────────────────────────────
 *
 * These are the functions a person is watching while they run. A gen-1 cold
 * start on `settleGift` is a pause after the user has already paid for the
 * gift, during a live stream, in front of an audience; on `startCall` it is a
 * delay before the phone rings.
 *
 * A warm instance removes that pause. It is NOT free: four pinned functions at
 * 256MB came to $40.14 a month on the first deploy, and before launch that buys
 * nothing — there is nobody to experience a cold start.
 *
 * So it is a switch. `WARM_INSTANCES=1` in the functions environment turns it
 * on; unset means zero and costs nothing. Turn it on at launch, not before.
 *
 * The rest of the codebase stays gen-1 — mixing generations in one project is
 * supported, and there is no reason to pay for warmth on a function nobody is
 * waiting for.
 *
 * DEPLOY NOTE: a gen-2 function cannot replace a gen-1 function of the same
 * name. If these were already deployed as gen-1, delete them first:
 *   firebase functions:delete settleGift startCall acceptCall declineCall tickCall endCall
 */
const MIN_INSTANCES = Number(process.env.WARM_INSTANCES ?? 0) || 0

const HOT = { region: 'asia-south1' as const, minInstances: MIN_INSTANCES }
const WARM = { region: 'asia-south1' as const }
import { accrueWeeklyEarning } from './payouts'
import { accrueBoards } from './leaderboards'
import { accrueHostStats, applyHostLevel, getHostLadder } from './hostStats'

const db = admin.firestore()

/**
 * Call billing — server-clocked, server-priced.
 *
 * ── The problem this replaces ────────────────────────────────────────────────
 *
 * `CallRepository.tickCall` ran on the CALLER'S DEVICE every ten seconds and
 * wrote both balances itself. Three consequences:
 *
 *   1. A modified client that simply stops ticking gets a free call. The host
 *      keeps streaming and is never paid.
 *   2. Eleven balance writes across two files produced ZERO ledger rows. A user
 *      who recharged and spent it all on calls left one recharge and an
 *      unexplained balance drop — nothing to show a bank during a chargeback.
 *   3. The rate came from the client, so it could be anything.
 *
 * Here the server owns the clock. Elapsed time is computed from `startedAt` on
 * the call document, never from a number the caller sends.
 *
 * ── THE BILLING RULE: WHOLE MINUTES, THE STARTED MINUTE COUNTS ───────────────
 *
 * The unit is the minute, priced at `perMinRateDiamonds`. There are no
 * ten-second increments anywhere any more (the old `TICK_SECONDS` arithmetic
 * rounded the quoted price up by a third of a percent and is gone).
 *
 *   connect   `acceptCall` charges the FIRST FULL MINUTE inside the transaction
 *             that activates the call: `tickIndex = 1`, `billedThroughMs =
 *             startedAt + 60 000`. A payer who cannot afford one minute is
 *             refused and the call is closed with nothing charged.
 *
 *   tick      `minutesDue = floor(elapsedSec / 60) + 1` — the minute that has
 *             started is owed in full. `minutesDue - tickIndex` whole minutes
 *             are charged, capped by what the payer can afford; if the next
 *             minute cannot be afforded the call ends at that boundary with
 *             `endReason: 'insufficient_diamonds'` and the minutes already
 *             charged stay charged. A tick from the EARNER's device charges
 *             nothing but refreshes `lastTickAt`, so a payer whose device has
 *             gone quiet is still billed for the time the earner evidenced.
 *
 *   end       `endCall`, the watchdog and a restriction-triggered end all bill
 *             up to and including the minute in progress at the END INSTANT:
 *             `max(1, ceil(elapsedSec / 60))`, never a partial minute. The end
 *             instant is "now" for a hang-up, the moment the gate fired for a
 *             gated end, and the LAST EVIDENCE OF ACTIVITY (`lastTickAt`, from
 *             either side) for the watchdog, which closes any call whose last
 *             tick is older than 120 s.
 *
 *   boundary  at exactly 60.000 s a tick owes minute 2 (it has started); an end
 *             at exactly 60.000 s owes minute 1 only (minute 2 never ran).
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * `tickIndex` on the call document is the count of MINUTES already charged. A
 * replayed tick sees its index is not behind and charges nothing. Mobile
 * networks drop responses constantly; without this, every dropped response is
 * a double charge on a call that is already costing the user by the minute.
 *
 * Calls connected before this rule shipped carry `tickIndex` in ten-second
 * ticks and no `billingUnit`; `billedMinutesOf` converts them (rounding up, so
 * nothing already paid for is charged again) and they finish under this rule.
 */

const MINUTE_MS = 60_000

/** Stamped on every call this code creates or connects. Absent = legacy ticks. */
const BILLING_UNIT = 'minute'

/** Minutes owed by a tick: the minute that has started counts in full. */
export function minutesStartedBy(elapsedMs: number): number {
  const sec = Math.max(0, elapsedMs) / 1000
  return Math.floor(sec / 60) + 1
}

/** Minutes owed at an end instant: through the minute in progress, never partial. */
export function minutesTouchedBy(elapsedMs: number): number {
  const sec = Math.max(0, elapsedMs) / 1000
  return Math.max(1, Math.ceil(sec / 60))
}

/** Minutes already charged on a call document, whichever rule it was connected under. */
function billedMinutesOf(call: Record<string, any>): number {
  const index = Math.max(0, Math.floor(Number(call.tickIndex ?? 0)))
  if (call.billingUnit === BILLING_UNIT) return index
  // Legacy ten-second ticks. Round UP: the money for a part-minute of ticks
  // has been taken, so that minute is treated as paid rather than paid twice.
  return Math.ceil(index / 6)
}

/**
 * B2c (3 Nov 2026): does this payer hold a free call card that can pay a first minute?
 *
 * Daily rewards have granted `videoCards` for months, and no call ever used one — the cards sat in My Bag doing
 * nothing. One card pays the FIRST minute of a paid call: the payer is charged nothing for it, the earner is paid
 * for it as for any minute, and Zipper bears that cost (`promoCredits/card_{callId}`). A free call (rate 0) never
 * spends a card.
 */
export function hasFreeCallCard(videoCards: unknown, perMin: number): boolean {
  const cards = Number(videoCards ?? 0)
  return perMin > 0 && Number.isFinite(cards) && cards >= 1
}

/** How many of `wanted` whole minutes a balance covers. A free call covers all of them. */
function affordableMinutes(balance: number, perMin: number, wanted: number): number {
  if (wanted <= 0) return 0
  if (perMin <= 0) return wanted
  return Math.max(0, Math.min(wanted, Math.floor(balance / perMin)))
}

/** For the payer's screen: further whole minutes the balance covers, or null on a free call. */
function minutesCoveredBy(balance: number, perMin: number): number | null {
  return perMin > 0 ? Math.max(0, Math.floor(balance / perMin)) : null
}

/** Firestore Timestamp → millis, or null when the field is not one. */
function millisOf(v: unknown): number | null {
  return v && typeof (v as { toMillis?: unknown }).toMillis === 'function'
    ? (v as admin.firestore.Timestamp).toMillis()
    : null
}

/**
 * Charge `minutes` whole minutes on a connected call, in the caller's
 * transaction: payer debited, earner credited, the week bucket and the day's
 * host stats accrued, the call's counters advanced and the two ledger rows
 * updated. One function, so `acceptCall`, `tickCall` and settlement cannot
 * price a minute three different ways.
 *
 * ── One ledger row per call per side, not one per minute ─────────────────────
 *
 * `users/{uid}/diamondTransactions/call_{callId}` (and the bean twin) is
 * created when the first minute is charged and MERGED on every later charge:
 * `amount` increments, `balanceAfter` is replaced, `timestamp` stays the call's
 * start. The wallet screen streams every row of the collection, so a thirty-
 * minute call is one row that grows, not thirty rows; and a deterministic id
 * means a replayed settlement cannot add a second row. The row exists from the
 * first minute, so a call that dies before settlement still leaves its trail.
 */
function chargeMinutes(
  tx: admin.firestore.Transaction,
  p: {
    callId: string
    call: Record<string, any>
    callRef: admin.firestore.DocumentReference
    payerRef: admin.firestore.DocumentReference
    earnerRef: admin.firestore.DocumentReference
    payerSnap: admin.firestore.DocumentSnapshot
    earnerSnap: admin.firestore.DocumentSnapshot
    startedAt: admin.firestore.Timestamp
    minutesAlready: number
    minutes: number
    /** Extra fields for the call document, written in the same update. */
    callPatch?: Record<string, any>
    /**
     * Settlement only: the closing stamp for the two ledger rows. `totals` is
     * for a call connected under the old ten-second rule, whose earlier ticks
     * wrote no row at all — the row is then written with the call's whole
     * total rather than incremented, so the ledger still equals the balance
     * change. Firestore applies one write per document per transaction here,
     * which is why this travels into the same `set` rather than following it.
     */
    ledgerFinal?: {
      durationSeconds: number
      totals: { diamonds: number; beans: number } | null
    }
    /** Settlement only: counters folded into the same day-stats write (e.g. `calls: 1`). */
    statsExtra?: { calls?: number }
    /**
     * B2c: how many of `minutes` a FREE CALL CARD pays for (0 or 1 — one card, the first minute). The payer is
     * not debited for them and one card is taken from `videoCards`; the earner is paid for them exactly as for a
     * paid minute, and Zipper bears that cost — recorded in `promoCredits/card_{callId}` for the finance reports.
     */
    cardMinutes?: number
  },
): { diamonds: number; beans: number; tickIndex: number; billedThroughMs: number } {
  const perMin = Math.max(0, Number(p.call.perMinRateDiamonds ?? 0))
  const pct = Number(p.call.receiverPct ?? 50)
  const minutes = Math.max(0, Math.floor(p.minutes))
  const cardMinutes = perMin > 0 ? Math.max(0, Math.min(minutes, Math.floor(Number(p.cardMinutes ?? 0)))) : 0
  // The value of every minute charged, paid ones and card ones alike: the earner is paid on all of it.
  const grossDiamonds = minutes * perMin
  const cardDiamonds = cardMinutes * perMin
  // What the PAYER pays.
  const diamonds = grossDiamonds - cardDiamonds
  // Floor, not round: never credit a bean that was not paid for.
  const beans = Math.floor((grossDiamonds * pct) / 100)
  const cardBeans = Math.floor((cardDiamonds * pct) / 100)
  const tickIndex = p.minutesAlready + minutes
  const billedThroughMs = p.startedAt.toMillis() + tickIndex * MINUTE_MS
  const now = admin.firestore.FieldValue.serverTimestamp()
  const inc = admin.firestore.FieldValue.increment

  tx.update(p.callRef, {
    tickIndex,
    billingUnit: BILLING_UNIT,
    billedThroughMs,
    diamondsCharged: inc(diamonds),
    beansCredited: inc(beans),
    ...(cardMinutes > 0 ? { cardMinutes: inc(cardMinutes), cardDiamonds: inc(cardDiamonds) } : {}),
    ...(p.callPatch ?? {}),
  })

  const payerBalanceAfter = Number(p.payerSnap.get('diamonds') ?? 0) - diamonds
  const earnerBalanceAfter = Number(p.earnerSnap.get('beans') ?? 0) + beans
  const payerUid = p.payerRef.id
  const earnerUid = p.earnerRef.id

  if (cardMinutes > 0) {
    tx.set(db.collection('promoCredits').doc(`card_${p.callId}`), {
      kind: 'free_call_card_redeemed',
      uid: payerUid,
      hostUid: earnerUid,
      callId: p.callId,
      cards: 1,
      minutes: cardMinutes,
      diamondValue: cardDiamonds,
      beansCredited: cardBeans,
      ratePerMin: perMin,
      receiverPct: pct,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  }

  if (minutes > 0) {
    tx.update(p.payerRef, {
      diamonds: inc(-diamonds),
      ...(cardMinutes > 0 ? { videoCards: inc(-1) } : {}),
    })
    tx.update(p.earnerRef, {
      beans: inc(beans),
      totalBeansEarned: inc(beans),
      hostCallEarnings: inc(beans),
    })
    // Same transaction as the credit — they must not diverge.
    accrueWeeklyEarning(tx, p.earnerRef, beans, 'call')
    // B8: a host's call earnings count on the Top hosts board, in the same transaction.
    if (beans > 0 && p.earnerSnap.get('isHost') === true) {
      accrueBoards(tx, [{
        board: 'hosts', uid: earnerUid, score: beans,
        name: String(p.earnerSnap.get('displayName') ?? p.earnerSnap.get('name') ?? '').trim() || 'Zipper user',
        photoUrl: String(p.earnerSnap.get('photoUrl') ?? ''),
      }])
    }
  }
  // Seconds, not calls: the call is counted once when it ends (`statsExtra`),
  // but the time has to accumulate as it passes, or a host watching Host Home
  // during a long call sees nothing move. No `isHost` gate and no level check
  // here, both deliberately: the level is applied at settlement, which reads
  // the earner's document for other reasons, and the nightly sweep is the
  // backstop. One day-stats write per charge, the settlement counter folded in.
  accrueHostStats(tx, p.earnerRef, {
    beans, source: 'call', callSeconds: minutes * 60, ...(p.statsExtra ?? {}),
  })

  // ── Ledger. The gap that loses chargebacks. ──────────────────────────────
  const totals = p.ledgerFinal?.totals ?? null
  // B2c: a card minute charges the payer nothing but pays the earner — both rows are still written.
  const ledgerWorthWriting = totals ? totals.diamonds > 0
    : (diamonds > 0 || cardMinutes > 0 || (p.ledgerFinal != null && tickIndex > 0 && perMin > 0))
  if (!ledgerWorthWriting) return { diamonds, beans, tickIndex, billedThroughMs }

  const label = p.ledgerFinal
    ? `Video call — ${Math.floor(p.ledgerFinal.durationSeconds / 60)}m ${p.ledgerFinal.durationSeconds % 60}s`
    : `Video call — ${tickIndex} min`
  const closing = p.ledgerFinal ? { durationSeconds: p.ledgerFinal.durationSeconds } : {}

  tx.set(p.payerRef.collection('diamondTransactions').doc(`call_${p.callId}`), {
    type: 'debit',
    amount: totals ? totals.diamonds : inc(diamonds),
    balanceAfter: payerBalanceAfter,
    reason: 'video_call',
    reasonLabel: label,
    relatedUid: earnerUid,
    relatedUserName: p.earnerSnap.get('displayName') ?? p.earnerSnap.get('name') ?? '',
    callId: p.callId,
    minutesBilled: tickIndex,
    ratePerMin: perMin,
    context: 'call',
    // B2c: minutes a free call card paid for — not part of `amount`, which is what the payer paid.
    ...(cardMinutes > 0 ? { freeCardMinutes: inc(cardMinutes), freeCardsUsed: inc(1) } : {}),
    // The call's start, every time: a merge that re-sets the same value moves
    // nothing, and the row sorts where the call began.
    timestamp: p.startedAt,
    updatedAt: now,
    ...closing,
  }, { merge: true })
  tx.set(p.earnerRef.collection('beanTransactions').doc(`call_${p.callId}`), {
    type: 'credit',
    amount: totals ? totals.beans : inc(beans),
    balanceAfter: earnerBalanceAfter,
    reason: 'video_call',
    reasonLabel: label,
    relatedUid: payerUid,
    relatedUserName: p.payerSnap.get('displayName') ?? p.payerSnap.get('name') ?? '',
    callId: p.callId,
    minutesBilled: tickIndex,
    receiverPct: pct,
    context: 'call',
    timestamp: p.startedAt,
    updatedAt: now,
    ...closing,
  }, { merge: true })

  return { diamonds, beans, tickIndex, billedThroughMs }
}

interface StartCallRequest {
  peerUid: string
  idempotencyKey: string
}

interface CallIdRequest {
  callId: string
}

/**
 * The money math lives in `pricing.ts`.
 *
 * It was moved out so it could be TESTED. The 3x3 split table and the
 * who-pays rule are the two things here that can be wrong silently — a bad
 * cell underpays a whole gender of hosts and nothing throws — and neither
 * could be exercised while they sat in this file, because importing this
 * module runs `admin.firestore()` and needs a live app.
 *
 * `functions/test/pricing.test.js` now walks every pairing on every deploy.
 */
import { rateFor } from './pricing'
import {
  assertActiveSession, presentedSessionId, restrictionVerdict, signInPredatesCutoff,
} from './mobileSession'
import {
  hostRoleSuspension, hostSuspendedMessage, hostSuspensionDetails,
  HOST_UNAVAILABLE, HOST_UNAVAILABLE_REFUSAL, type FieldReader,
} from './hostEligibility'

/**
 * P0-6: end reasons decided by the server inside `tickCall`. A call ended for
 * one of these bills through the minute in progress at the moment the server
 * decided it (`endingAt`), not at whatever later moment the client calls
 * `endCall`, and the server's reason survives whatever the client sends.
 *
 * §5 `host_suspended`: the earning Host's role was suspended mid-call. The
 * minutes already charged stay charged; nothing after the gate instant is.
 */
const GATED_END_REASONS = new Set([
  'party_restricted', 'session_displaced', 'insufficient_diamonds', 'host_suspended',
])

/**
 * §5 Host role suspension, on a call: is the side that EARNS a Host whose role
 * is suspended? A suspended Host earns nothing new — no call is placed, picked
 * up or billed with them as the earner — while the same person may still PAY
 * for a call like any user (a viewer/user feature is not a Host one), and the
 * beans they already earned are untouched. `isHost` is asked first: the
 * suspension is a state of a held Host role.
 */
function earningHostSuspension(earner: FieldReader) {
  return earner.get('isHost') === true ? hostRoleSuspension(earner) : null
}


// ── startCall ────────────────────────────────────────────────────────────────

export const startCall = onCall(HOT, async (req: CallableRequest<StartCallRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const callerUid = context.auth?.uid
    if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in to call.')
    // Auth-only guard. See functions/src/mobileSession.ts: refuses when the
    // caller presents a session id that is not the account's active one.
    await assertActiveSession(callerUid, data, 'startCall', context.auth?.token)

    const { peerUid, idempotencyKey } = data ?? {}
    if (!peerUid || typeof peerUid !== 'string') {
      throw new HttpsError('invalid-argument', 'peerUid is required.')
    }
    if (peerUid === callerUid) {
      throw new HttpsError('invalid-argument', 'You cannot call yourself.')
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new HttpsError('invalid-argument', 'idempotencyKey is required.')
    }

    const callerRef = db.collection('users').doc(callerUid)
    const peerRef   = db.collection('users').doc(peerUid)
    const configRef = db.collection('appConfig').doc('economy')
    const claimRef  = db.collection('callIdempotency').doc(`${callerUid}_${idempotencyKey}`)
    const blockRef  = peerRef.collection('blocked').doc(callerUid)

    return db.runTransaction(async (tx) => {
      const [claimSnap, callerSnap, peerSnap, cfgSnap, blockSnap] = await Promise.all([
        tx.get(claimRef), tx.get(callerRef), tx.get(peerRef), tx.get(configRef), tx.get(blockRef),
      ])

      if (claimSnap.exists) return { ...claimSnap.data(), replayed: true }
      if (!callerSnap.exists) throw new HttpsError('not-found', 'Your account was not found.')
      if (!peerSnap.exists)   throw new HttpsError('not-found', 'That person was not found.')
      if (blockSnap.exists)   throw new HttpsError('permission-denied', 'You cannot call this person.')

      const caller = callerSnap.data() as Record<string, any>
      const peer   = peerSnap.data() as Record<string, any>
      const cfg    = (cfgSnap.data() ?? {}) as Record<string, any>

      /*
       * BOTH sides, not just the peer.
       *
       * Only the person being called was checked, so a banned account could
       * still place calls — and since the caller is usually the payer, it was
       * the banned account spending that went unchecked.
       */
      if (caller.isBanned === true) {
        throw new HttpsError('permission-denied', 'This account is restricted.')
      }
      if (peer.isBanned === true) {
        throw new HttpsError('permission-denied', 'That account is unavailable.')
      }

      // B7 (3 Nov 2026): somebody hosting their own party room may switch incoming calls off while they are in it.
      // Read here, before any write, from the room the peer's presence names.
      const peerRoomId = String(peer.partyRoomId ?? '')
      if (peer.isInParty === true && peerRoomId) {
        const roomSnap = await tx.get(db.collection('partyRooms').doc(peerRoomId))
        if (roomSnap.exists && roomSnap.get('isActive') !== false && roomSnap.get('hostUid') === peerUid
          && roomSnap.get('ownerBlocksCalls') === true) {
          throw new HttpsError(
            'failed-precondition',
            `${peer.displayName ?? peer.name ?? 'They'} is hosting a party room and is not taking calls right now.`,
            { code: 'PEER_IN_PARTY' },
          )
        }
      }

      const { perMin, pct, earner, payer } = rateFor(cfg, caller, peer)

      /*
       * §5: a suspended Host role takes no new paid call — rung by a user, or
       * ringing one. Asked of the EARNING side as `rateFor` decided it, so a
       * suspended Host who dials another Host (and pays, as any caller does)
       * is a user making a call and is let through. The Host is told why and
       * until when; the person ringing them is told only that this host is
       * not taking calls — the reason is not theirs to read.
       */
      const earnerSuspension = earningHostSuspension(earner === 'caller' ? callerSnap : peerSnap)
      if (earnerSuspension) {
        if (earner === 'caller') {
          throw new HttpsError(
            'permission-denied', hostSuspendedMessage(earnerSuspension), hostSuspensionDetails(earnerSuspension),
          )
        }
        throw new HttpsError('failed-precondition', HOST_UNAVAILABLE_REFUSAL, { code: HOST_UNAVAILABLE })
      }

      /*
       * One minute up front — CHECKED AGAINST THE PAYER.
       *
       * This used to read `caller.diamonds` unconditionally, which is wrong in
       * exactly the case the payer rule exists for. A host ringing a user is
       * the earner, not the payer, and the check refused them for having an
       * empty wallet: "You need 1250 diamonds for one minute" on a call that
       * would have PAID them. Meanwhile the user who actually owed the money
       * was never checked at all, so a broke user was rung, picked up, and had
       * the call torn down on the first tick with `diamonds_exhausted` — a
       * connect-then-drop that reads as a fault in the product.
       *
       * `tickCall` has always debited `payerUid`. This is the same question,
       * asked before the phone rings; `acceptCall` asks it again at pick-up and
       * answers it by taking the first minute.
       */
      const payerIsCaller = payer === 'caller'
      const payerUser = payerIsCaller ? caller : peer
      const balance = Number(payerUser.diamonds ?? 0)
      // B2c: a free call card pays the first minute, so a payer holding one may ring with an empty wallet.
      if (balance < perMin && !hasFreeCallCard(payerUser.videoCards, perMin)) {
        throw new HttpsError(
          'failed-precondition',
          payerIsCaller
            ? `You need ${perMin} diamonds for one minute. You have ${balance}.`
            : `${peer.displayName ?? peer.name ?? 'They'} does not have enough ` +
              'diamonds for this call right now.',
        )
      }

      const callRef = db.collection('calls').doc()
      const now = admin.firestore.FieldValue.serverTimestamp()

      tx.set(callRef, {
        callId: callRef.id,
        callerId: callerUid,
        callerName: caller.displayName ?? caller.name ?? '',
        callerPhotoUrl: caller.photoUrl ?? '',
        receiverId: peerUid,
        receiverName: peer.displayName ?? peer.name ?? '',
        receiverPhotoUrl: peer.photoUrl ?? '',
        status: 'ringing',
        channelName: callRef.id,
        createdAt: now,
        startedAt: null,
        perMinRateDiamonds: perMin,
        receiverPct: pct,
        // Which side earns. The payer is always the other one — `settleAndClose`
        // and `tickCall` both derive it that way rather than storing a second
        // field that could drift out of step with this one.
        earner,
        // Minutes charged so far. The server's only memory of what it has billed.
        tickIndex: 0,
        billingUnit: BILLING_UNIT,
        billedThroughMs: null,
        diamondsCharged: 0,
        beansCredited: 0,
      })

      const result = { callId: callRef.id, perMinRateDiamonds: perMin, receiverPct: pct }
      tx.set(claimRef, { ...result, createdAt: now })
      return { ...result, replayed: false }
    })
  })

// ── acceptCall / declineCall ─────────────────────────────────────────────────

/**
 * The receiver picks up. This is where the clock starts.
 *
 * It has to be a function, not a client write, for two reasons.
 *
 * `startedAt` is the only thing tickCall and endCall measure against. The
 * client set it to `System.currentTimeMillis()` — a device clock, and a plain
 * Long. The server reads it as a Firestore Timestamp and calls `.toMillis()`
 * on it, which a Long does not have, so every tick would have thrown. And even
 * with the right type, a phone whose clock is set back an hour produces a
 * negative elapsed and a free call.
 *
 * Only the receiver may accept, and only from `ringing`. Accepting twice must
 * not restart the clock and wipe out the time already billed.
 *
 * ── The first minute is charged HERE ─────────────────────────────────────────
 *
 * The call becomes active and the first full minute is paid in the same
 * transaction. `startCall` checked that the payer could afford a minute before
 * the phone rang; this is the same question asked again at the moment it
 * matters, against the balance as it is now, and answered by taking the money.
 * A payer who can no longer afford one minute is refused exactly as
 * `startCall` refuses — `failed-precondition`, the same sentence — and the
 * ringing call is closed with nothing charged, so neither phone keeps ringing
 * for a call that cannot happen.
 *
 * `startedAt` is the function's clock as a concrete Timestamp rather than the
 * server-timestamp sentinel: `billedThroughMs` has to be a number the client
 * can read back, and it is `startedAt + 60 000`.
 */
export const acceptCall = onCall(HOT, async (req: CallableRequest<CallIdRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const uid = context.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Not signed in.')
    await assertActiveSession(uid, req.data, 'acceptCall', context.auth?.token)   // Phase 1A (SESSION-001/003)
    const { callId } = data ?? {}
    if (!callId) throw new HttpsError('invalid-argument', 'callId is required.')

    const callRef = db.collection('calls').doc(callId)

    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(callRef)
      if (!snap.exists) throw new HttpsError('not-found', 'That call no longer exists.')
      const call = snap.data() as Record<string, any>

      if (call.receiverId !== uid) {
        throw new HttpsError('permission-denied', 'This is not your call.')
      }
      // Idempotent: a double-tap on Accept returns the existing state rather
      // than resetting startedAt to now and discarding the elapsed time.
      if (call.status === 'connected') {
        return {
          callId, status: 'connected', alreadyConnected: true,
          minutesBilled: billedMinutesOf(call),
          billedThroughMs: Number(call.billedThroughMs ?? 0) || null,
          startedAtMs: millisOf(call.startedAt),
          perMinRateDiamonds: Number(call.perMinRateDiamonds ?? 0),
        }
      }
      if (call.status !== 'ringing') {
        throw new HttpsError('failed-precondition', 'This call has already ended.')
      }

      const payerUid  = call.earner === 'caller' ? call.receiverId : call.callerId
      const earnerUid = call.earner === 'caller' ? call.callerId  : call.receiverId
      const payerRef  = db.collection('users').doc(payerUid)
      const earnerRef = db.collection('users').doc(earnerUid)
      const [payerSnap, earnerSnap] = await Promise.all([tx.get(payerRef), tx.get(earnerRef)])

      const perMin = Math.max(0, Number(call.perMinRateDiamonds ?? 0))
      // The receiver is the one accepting; when the receiver is also the payer
      // the refusal is addressed to them, otherwise it names the caller.
      const acceptorPays = payerUid === uid
      const stamp = admin.firestore.FieldValue.serverTimestamp()

      // A ringing call that cannot become a call: closed like a decline, with
      // the same zero-money history row, and the reason on the document so the
      // caller's screen learns why it stopped ringing.
      const closeUnconnected = (endReason: string) => {
        tx.update(callRef, { status: 'declined', endReason, endedAt: stamp })
        tx.set(db.collection('callHistory').doc(callId), {
          ...call,
          callerUid:   call.callerId,
          receiverUid: call.receiverId,
          status: 'declined',
          endReason,
          endedAt: stamp,
          timestamp: stamp,
          durationSeconds: 0,
          diamondsCharged: 0,
          costDiamonds: 0,
          beansCredited: 0,
          beansEarned: 0,
          beneficiaryUid: call.earner ?? null,
          platformCut: 0,
        })
      }

      // Neither side may be restricted at the moment money first moves. The
      // receiver was checked by the session gate above; the other party was
      // checked when the call was placed, and a ban in between is rare but is
      // exactly the case where a first minute must not be taken.
      const restricted = !payerSnap.exists || !earnerSnap.exists
        || restrictionVerdict((f) => payerSnap.get(f)) || restrictionVerdict((f) => earnerSnap.get(f))
      if (restricted) {
        closeUnconnected('party_restricted')
        return { refused: new HttpsError('permission-denied', 'This call cannot be connected right now.') }
      }

      // §5: the Host role of the earning side was suspended while it rang. The
      // first minute is never taken; the ring is closed with the reason on the
      // call. The suspended Host picking up is told why; a user picking up a
      // call a suspended Host placed is told only that it cannot connect.
      const earnerSuspension = earningHostSuspension(earnerSnap)
      if (earnerSuspension) {
        closeUnconnected('host_suspended')
        return {
          refused: earnerUid === uid
            ? new HttpsError(
              'permission-denied', hostSuspendedMessage(earnerSuspension), hostSuspensionDetails(earnerSuspension),
            )
            : new HttpsError('failed-precondition', HOST_UNAVAILABLE_REFUSAL, { code: HOST_UNAVAILABLE }),
        }
      }

      const balance = Number(payerSnap.get('diamonds') ?? 0)
      // B2c: one free call card pays the first minute when the payer holds one (it is taken in `chargeMinutes`).
      const useCard = hasFreeCallCard(payerSnap.get('videoCards'), perMin)
      if (balance < perMin && !useCard) {
        closeUnconnected('insufficient_diamonds')
        const payerName = payerSnap.get('displayName') ?? payerSnap.get('name') ?? 'They'
        return {
          refused: new HttpsError(
            'failed-precondition',
            acceptorPays
              ? `You need ${perMin} diamonds for one minute. You have ${balance}.`
              : `${payerName} does not have enough diamonds for this call right now.`,
          ),
        }
      }

      const nowMs = Date.now()
      const startedAt = admin.firestore.Timestamp.fromMillis(nowMs)
      const charged = chargeMinutes(tx, {
        callId, call, callRef, payerRef, earnerRef, payerSnap, earnerSnap,
        startedAt,
        minutesAlready: 0,
        minutes: 1,
        cardMinutes: useCard ? 1 : 0,
        callPatch: {
          status:     'connected',
          startedAt,
          lastTickAt: startedAt,   // so the watchdog has a baseline from the first second
        },
      })
      return {
        callId,
        status: 'connected',
        alreadyConnected: false,
        startedAtMs: nowMs,
        minutesBilled: charged.tickIndex,
        billedThroughMs: charged.billedThroughMs,
        perMinRateDiamonds: perMin,
        charged: charged.diamonds,
        beans: charged.beans,
      }
    })

    // Thrown after the transaction committed, so the refusal and the closed
    // call document land together rather than the refusal alone.
    if ('refused' in outcome) throw outcome.refused
    return outcome
  })

/** The receiver declines, or lets it ring out. No money moves. */
export const declineCall = onCall(WARM, async (req: CallableRequest<{ callId: string; reason?: string }>) => {
    const data = req.data
    const context = { auth: req.auth }
    const uid = context.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Not signed in.')
    const { callId, reason } = data ?? {}
    if (!callId) throw new HttpsError('invalid-argument', 'callId is required.')

    const callRef = db.collection('calls').doc(callId)

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(callRef)
      if (!snap.exists) throw new HttpsError('not-found', 'That call no longer exists.')
      const call = snap.data() as Record<string, any>

      // Either party may cancel a ringing call: the receiver declines, the
      // caller gives up before it is answered.
      if (call.receiverId !== uid && call.callerId !== uid) {
        throw new HttpsError('permission-denied', 'This is not your call.')
      }
      if (call.status !== 'ringing') {
        return { callId, status: call.status, alreadyResolved: true }
      }

      const endReason = call.receiverId === uid
        ? (reason === 'missed' ? 'missed' : 'receiver_declined')
        : 'caller_cancelled'
      const status = endReason === 'missed' ? 'missed' : 'declined'
      const now = admin.firestore.FieldValue.serverTimestamp()

      tx.update(callRef, { status, endReason, endedAt: now })

      /*
       * A call that never connected still HAPPENED, and belongs in the history.
       *
       * `callHistory` was written in exactly one place — `settleAndClose`, which
       * runs only for a call that connected. So declines, cancellations and
       * missed calls left no trace anywhere a person can see: a host who missed
       * ten calls overnight opened the app to an empty list, and the "Missed"
       * row the history screen already knows how to draw was unreachable except
       * by a caller cancelling their own call.
       *
       * Written here with the same shape `settleAndClose` uses, and with the
       * money fields explicitly zero rather than absent — a reader summing them
       * must not have to know which of the two writers produced the row.
       */
      tx.set(db.collection('callHistory').doc(callId), {
        ...call,
        callerUid:   call.callerId,
        receiverUid: call.receiverId,
        status,
        endReason,
        endedAt: now,
        timestamp: now,
        durationSeconds: 0,
        diamondsCharged: 0,
        costDiamonds: 0,
        beansCredited: 0,
        beansEarned: 0,
        beneficiaryUid: call.earner ?? null,
        platformCut: 0,
      })

      return { callId, status, alreadyResolved: false }
    })
  })

// ── tickCall ─────────────────────────────────────────────────────────────────

export const tickCall = onCall(HOT, async (req: CallableRequest<CallIdRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const uid = context.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Not signed in.')
    const { callId } = data ?? {}
    if (!callId) throw new HttpsError('invalid-argument', 'callId is required.')

    const callRef = db.collection('calls').doc(callId)

    return db.runTransaction(async (tx) => {
      const callSnap = await tx.get(callRef)
      if (!callSnap.exists) throw new HttpsError('not-found', 'Call not found.')
      const call = callSnap.data() as Record<string, any>

      if (uid !== call.callerId && uid !== call.receiverId) {
        throw new HttpsError('permission-denied', 'Not your call.')
      }
      if (call.status !== 'connected') {
        // `ending` is the server having already decided: the device should let
        // go now, and `endCall` is idempotent when it does.
        return {
          charged: 0, beans: 0,
          endNow: call.status === 'ended' || call.status === 'ending',
          status: call.status,
          ...(call.endReason ? { endReason: String(call.endReason) } : {}),
          tickIndex: billedMinutesOf(call),
          minutesBilled: billedMinutesOf(call),
        }
      }

      const payerUid  = call.earner === 'caller' ? call.receiverId : call.callerId
      const earnerUid = call.earner === 'caller' ? call.callerId  : call.receiverId
      const minutesBilled = billedMinutesOf(call)
      const perMin = Math.max(0, Number(call.perMinRateDiamonds ?? 0))
      const startedAtMs = millisOf(call.startedAt)
      const nowMs = Date.now()
      const stamp = admin.firestore.FieldValue.serverTimestamp()

      // The shape every answer shares. Minute fields are additive: `charged`,
      // `beans`, `endNow`, `status` and `tickIndex` keep their old meaning.
      const base = {
        status: call.status,
        tickIndex: minutesBilled,
        minutesBilled,
        perMinRateDiamonds: perMin,
        startedAtMs,
        elapsedSeconds: startedAtMs == null ? 0 : Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
        billedThroughMs: startedAtMs == null ? null : startedAtMs + minutesBilled * MINUTE_MS,
        nextChargeAtMs: startedAtMs == null ? null : startedAtMs + minutesBilled * MINUTE_MS,
      }

      // A tick from the EARNER's device charges nothing. It does refresh
      // `lastTickAt`: it is evidence the call is still running, so the watchdog
      // stays away and, when the call finally ends, settlement bills the quiet
      // payer through the minute the earner last evidenced (M-8).
      if (uid !== payerUid) {
        tx.update(callRef, { lastTickAt: stamp, lastEarnerTickAt: stamp })
        return { ...base, charged: 0, beans: 0, endNow: false, role: 'earner' }
      }

      if (startedAtMs == null) {
        return { ...base, charged: 0, beans: 0, endNow: false, role: 'payer' }
      }

      // THE SERVER COMPUTES ELAPSED. Nothing the client sends is used. The
      // minute that has started is owed in full.
      const minutesDue = minutesStartedBy(nowMs - startedAtMs)
      const outstanding = minutesDue - minutesBilled

      const payerRef  = db.collection('users').doc(payerUid)
      const earnerRef = db.collection('users').doc(earnerUid)

      const [payerSnap, earnerSnap] = await Promise.all([tx.get(payerRef), tx.get(earnerRef)])

      // P0-6 (FIN-2): a call ends when either party may no longer be on it
      // (banned, suspended, deleting), or when the payer's sign-in predates the
      // account's cut-off or no longer holds the session. Ended, not refused:
      // the device can always let go of the call. The gate instant is stamped
      // so settlement bills through the minute in progress at THAT moment, not
      // at whatever later moment the client gets round to calling endCall.
      const restricted = restrictionVerdict((f) => payerSnap.get(f))
        || restrictionVerdict((f) => earnerSnap.get(f))
      const presented = presentedSessionId(data)
      const recordedSession = String(
        (payerSnap.get('activeMobileSession') as Record<string, unknown> | undefined)?.sessionId ?? '',
      )
      const displaced = signInPredatesCutoff(
        payerSnap.get('credentialsValidAfter'), req.auth?.token?.auth_time, Math.floor(nowMs / 1000),
      ) || (presented !== '' && recordedSession !== '' && presented !== recordedSession)
      // §5: the earning Host's role was suspended mid-call. Ended at this gate
      // like a restriction: the minutes charged so far stay charged (they are
      // earnings already made), settlement bills through this instant only.
      const hostSuspended = earningHostSuspension(earnerSnap) !== null
      if (restricted || displaced || hostSuspended) {
        const endReason = restricted ? 'party_restricted' : displaced ? 'session_displaced' : 'host_suspended'
        logger.warn('tickCall ended a call at the gate', { callId, endReason })
        tx.update(callRef, {
          status: 'ending', endReason,
          endingAt: admin.firestore.Timestamp.fromMillis(nowMs),
          lastTickAt: stamp, lastPayerTickAt: stamp,
        })
        return { ...base, charged: 0, beans: 0, endNow: true, status: 'ending', endReason, role: 'payer' }
      }

      const payerBalance = Number(payerSnap.get('diamonds') ?? 0)

      // A replayed tick — or simply one inside a minute already paid for —
      // lands here, charges nothing, and only refreshes the evidence of life.
      if (outstanding <= 0) {
        tx.update(callRef, { lastTickAt: stamp, lastPayerTickAt: stamp })
        return {
          ...base, charged: 0, beans: 0, endNow: false, role: 'payer',
          affordableMinutes: minutesCoveredBy(payerBalance, perMin),
        }
      }

      // Charge only the whole minutes they can afford. If that is fewer than
      // are owed, the call ends at this boundary: the minutes already charged
      // stay charged, the one that could not be paid for is not started.
      const affordable = affordableMinutes(payerBalance, perMin, outstanding)
      const endNow = affordable < outstanding
      const endPatch = endNow
        ? {
            status: 'ending',
            endReason: 'insufficient_diamonds',
            endingAt: admin.firestore.Timestamp.fromMillis(nowMs),
          }
        : {}

      const charged = chargeMinutes(tx, {
        callId, call, callRef, payerRef, earnerRef, payerSnap, earnerSnap,
        startedAt: admin.firestore.Timestamp.fromMillis(startedAtMs),
        minutesAlready: minutesBilled,
        minutes: affordable,
        callPatch: { lastTickAt: stamp, lastPayerTickAt: stamp, ...endPatch },
      })

      return {
        ...base,
        charged: charged.diamonds,
        beans: charged.beans,
        endNow,
        status: endNow ? 'ending' : 'connected',
        ...(endNow ? { endReason: 'insufficient_diamonds' } : {}),
        tickIndex: charged.tickIndex,
        minutesBilled: charged.tickIndex,
        billedThroughMs: charged.billedThroughMs,
        nextChargeAtMs: charged.billedThroughMs,
        affordableMinutes: minutesCoveredBy(payerBalance - charged.diamonds, perMin),
        role: 'payer',
      }
    })
  })

// ── endCall ──────────────────────────────────────────────────────────────────

export const endCall = onCall(WARM, async (req: CallableRequest<CallIdRequest & { reason?: string }>) => {
    const data = req.data
    const context = { auth: req.auth }
    const uid = context.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Not signed in.')
    const { callId, reason } = data ?? {}
    if (!callId) throw new HttpsError('invalid-argument', 'callId is required.')

    return settleAndClose(callId, uid, reason ?? 'user_ended')
  })

/**
 * Final settlement. Shared by endCall and the watchdog, so a call closed by a
 * crash settles exactly as one closed by a tap.
 *
 * Bills through the minute in progress at the END INSTANT, which is:
 *
 *   a hang-up            now
 *   a gated end          `endingAt`, the moment `tickCall` decided it
 *   the watchdog         `lastTickAt`, the last evidence of activity from
 *                        either device — two minutes of silence are not billed,
 *                        but a payer whose device went quiet while the earner's
 *                        kept ticking is billed for what the earner evidenced
 *
 * The amount is capped by the payer's balance: whatever cannot be paid for is
 * not charged, and the call simply ends.
 */
async function settleAndClose(
  callId: string,
  byUid: string | null,
  reason: string,
  opts: { endAt?: 'now' | 'lastTick' } = {},
) {
  const callRef = db.collection('calls').doc(callId)
  // Outside the transaction: ten-minute-cached config, and a transaction
  // cannot read after its first write.
  const ladder = await getHostLadder()

  return db.runTransaction(async (tx) => {
    const callSnap = await tx.get(callRef)
    if (!callSnap.exists) throw new HttpsError('not-found', 'Call not found.')
    const call = callSnap.data() as Record<string, any>

    if (byUid && byUid !== call.callerId && byUid !== call.receiverId) {
      throw new HttpsError('permission-denied', 'Not your call.')
    }
    if (call.status === 'ended') {
      return {
        alreadyEnded: true,
        diamondsCharged: call.diamondsCharged ?? 0,
        beansCredited: call.beansCredited ?? 0,
        durationSeconds: call.durationSeconds ?? 0,
        minutesBilled: billedMinutesOf(call),
      }
    }

    const startedAtMs = millisOf(call.startedAt)
    const nowMs = Date.now()

    // The server's reason stands over whatever the client sends afterwards,
    // and the server's end instant stands over "now".
    const gatedEnd = call.status === 'ending' && GATED_END_REASONS.has(String(call.endReason ?? ''))
    const finalReason = gatedEnd ? String(call.endReason) : reason
    const lastTickMs = millisOf(call.lastTickAt) ?? startedAtMs ?? nowMs
    const endingAtMs = millisOf(call.endingAt)
    let endMs = nowMs
    if (gatedEnd && endingAtMs != null) endMs = Math.min(endMs, endingAtMs)
    if (opts.endAt === 'lastTick') endMs = Math.min(endMs, lastTickMs)
    if (startedAtMs != null) endMs = Math.max(endMs, startedAtMs)

    const durationSeconds = startedAtMs == null ? 0 : Math.max(0, Math.floor((endMs - startedAtMs) / 1000))

    const payerUid  = call.earner === 'caller' ? call.receiverId : call.callerId
    const earnerUid = call.earner === 'caller' ? call.callerId  : call.receiverId
    const payerRef  = db.collection('users').doc(payerUid)
    const earnerRef = db.collection('users').doc(earnerUid)

    const [payerSnap, earnerSnap] = await Promise.all([tx.get(payerRef), tx.get(earnerRef)])

    // Whole minutes through the one in progress at the end instant, less the
    // minutes already charged, capped by the balance. Never a partial minute,
    // and never a minute that was not at least started.
    const perMin = Math.max(0, Number(call.perMinRateDiamonds ?? 0))
    const minutesAlready = billedMinutesOf(call)
    const minutesDue = startedAtMs == null ? 0 : minutesTouchedBy(endMs - startedAtMs)
    const payerBalance = Number(payerSnap.get('diamonds') ?? 0)
    const finalMinutes = affordableMinutes(payerBalance, perMin, minutesDue - minutesAlready)
    const now = admin.firestore.FieldValue.serverTimestamp()

    const finalDiamonds = finalMinutes * perMin
    const finalBeans    = Math.floor((finalDiamonds * Number(call.receiverPct ?? 50)) / 100)
    const totalDiamonds = Number(call.diamondsCharged ?? 0) + finalDiamonds
    const totalBeans    = Number(call.beansCredited ?? 0) + finalBeans
    // A call connected under the old ten-second rule has no ledger row yet:
    // its row is written with the whole total, as that rule used to do.
    const legacy = call.billingUnit !== BILLING_UNIT

    const closingPatch = { status: 'ended', endReason: finalReason, endedAt: now, durationSeconds }

    // One write to the call document: the final minutes, the counters and the
    // closing fields together. The ledger rows were opened with the first
    // minute (see chargeMinutes); the same call stamps the final duration on
    // them.
    // The call itself is counted once, for a host, whether or not the last
    // minute earned anything — a call that ended is still a call taken. The
    // minutes' seconds were accrued as each minute was charged.
    const earnerIsHost = earnerSnap.get('isHost') === true
    const charged = startedAtMs == null
      ? { diamonds: 0, beans: 0, tickIndex: minutesAlready, billedThroughMs: null as number | null }
      : chargeMinutes(tx, {
          callId, call, callRef, payerRef, earnerRef, payerSnap, earnerSnap,
          startedAt: admin.firestore.Timestamp.fromMillis(startedAtMs),
          minutesAlready,
          minutes: finalMinutes,
          callPatch: closingPatch,
          ledgerFinal: {
            durationSeconds,
            totals: legacy ? { diamonds: totalDiamonds, beans: totalBeans } : null,
          },
          statsExtra: earnerIsHost ? { calls: 1 } : undefined,
        })
    if (startedAtMs == null) {
      // Never connected (a caller hanging up on a ring): nothing to bill.
      tx.update(callRef, { ...closingPatch, billingUnit: BILLING_UNIT })
    }

    if (earnerIsHost) {
      applyHostLevel(
        tx,
        earnerRef,
        Number(earnerSnap.get('hostLevel') ?? 0),
        Number(earnerSnap.get('hostCallEarnings') ?? 0) +
          Number(earnerSnap.get('hostGiftEarnings') ?? 0) +
          finalBeans,
        ladder,
      )
    }

    // CRM: reports.py:3443 scans platformRevenue for type == 'call'.
    // Field names are the ones it reads — renaming one drops it from the report.
    if (totalDiamonds > 0) {
      tx.set(db.collection('platformRevenue').doc(), {
        type: 'call',
        callerUid: call.callerId,
        receiverUid: call.receiverId,
        durationSeconds,
        minutesBilled: charged.tickIndex,
        grossDiamonds: totalDiamonds,
        payoutBeans: totalBeans,
        platformCut: totalDiamonds - totalBeans,
        // B2c: the part of `payoutBeans` a free call card paid for (Zipper's promotional cost, also in
        // `promoCredits/card_{callId}`). `platformCut` stays gross − payout, as the reconciliation recomputes it.
        promoDiamonds: Number(call.cardDiamonds ?? 0) || 0,
        callId,
        timestamp: now,
      })
    }

    // ── Field names the history screen and the indexes already use ──────────
    //
    // Spreading `...call` alone wrote `callerId` / `receiverId`, but
    // CallRepository.getCallHistory queries `callerUid` and `receiverUid` —
    // and those are the fields firestore.indexes.json has composite indexes
    // on. The screen would have been permanently empty and the query would
    // have needed an index that does not exist. `beansEarned` and `timestamp`
    // are read by the same screen; they are duplicated rather than renamed so
    // the CRM keeps the unambiguous internal names too.
    tx.set(db.collection('callHistory').doc(callId), {
      ...call,
      callerUid:   call.callerId,
      receiverUid: call.receiverId,
      status: 'ended',
      endReason: finalReason,
      endedAt: now,
      timestamp: now,
      durationSeconds,
      diamondsCharged: totalDiamonds,
      costDiamonds: totalDiamonds,
      beansCredited: totalBeans,
      beansEarned: totalBeans,
      beneficiaryUid: call.earner,
      platformCut: totalDiamonds - totalBeans,
    })

    return {
      alreadyEnded: false,
      durationSeconds,
      diamondsCharged: totalDiamonds,
      beansCredited: totalBeans,
      minutesBilled: charged.tickIndex,
      billedThroughMs: charged.billedThroughMs,
      endReason: finalReason,
    }
  })
}

// ── Watchdog ─────────────────────────────────────────────────────────────────

/**
 * How long a call rings before it is a missed call.
 *
 * A phone rings for about this long and then stops. Nothing about that is
 * arbitrary: it is roughly how long somebody will stare at a ringing screen
 * before deciding nobody is there.
 */
const RING_TIMEOUT_SECONDS = 45

/**
 * Closes calls whose client stopped talking to us, and calls nobody answered.
 *
 * ── THE CONNECTED HALF ───────────────────────────────────────────────────────
 *
 * Without this, force-quitting the app leaves the row `connected` forever: the
 * caller stops being charged and the host is never paid for the time. A
 * force-quit becomes a free call, which is not a bug anyone reports.
 *
 * Two minutes past the last tick FROM EITHER SIDE — comfortably beyond a
 * tunnel or a lift, and well short of anything a user would notice. The call
 * is then billed through the minute containing that last tick, not through
 * the silence: `settleAndClose(…, { endAt: 'lastTick' })`.
 *
 * ── THE RINGING HALF, AND THE CHARGE IT PREVENTS ─────────────────────────────
 *
 * Nothing used to close a `ringing` call. Not the sweep — it looked only at
 * `connected` and `ending` — and not the client: `markMissed` existed in the
 * repository with no caller anywhere in the app, and neither call screen had a
 * ring timeout. So an unanswered call rang forever, as a live document.
 *
 * That is not merely untidy, it takes money. `incomingCallFlow` queries
 * `receiverId == me && status == 'ringing'` with no age limit, so the abandoned
 * call re-rings the next time the receiver opens the app — hours or days later.
 * They answer. `acceptCall` accepts any `ringing` call and stamps `startedAt`
 * and `lastTickAt` at that moment. The caller's app is long gone, so nobody
 * ticks — and the first minute is charged at accept, for a conversation
 * neither of them had, paying the receiver for it.
 *
 * So a ring now expires like a phone: `declineCall`'s own `missed` path, which
 * moves no money and writes the reason, reached from here when nobody picked
 * up in time. The client is free to time out earlier and show "no answer"; this
 * is the backstop that holds when the client is gone.
 */
export const sweepStaleCalls = functions
  .region('asia-south1')
  .pubsub.schedule('* * * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = Date.now()

    // ── Connected calls whose client went silent ────────────────────────────
    const cutoff = admin.firestore.Timestamp.fromMillis(now - 2 * 60 * 1000)
    const stale = await db.collection('calls')
      .where('status', 'in', ['connected', 'ending'])
      .where('lastTickAt', '<', cutoff)
      .limit(50)
      .get()

    let closed = 0
    for (const doc of stale.docs) {
      try {
        await settleAndClose(doc.id, null, 'watchdog_timeout', { endAt: 'lastTick' })
        closed++
      } catch (err) {
        logger.error(`sweepStaleCalls: could not close ${doc.id}`, err)
      }
    }

    // ── Calls nobody answered ───────────────────────────────────────────────
    //
    // A separate query rather than an `in` on three statuses, because the two
    // are measured against different fields: a connected call ages from its
    // last tick, a ringing one from when it was created. No money moves here —
    // the call never connected, so there is nothing to settle.
    const ringCutoff = admin.firestore.Timestamp.fromMillis(
      now - RING_TIMEOUT_SECONDS * 1000,
    )
    const unanswered = await db.collection('calls')
      .where('status', '==', 'ringing')
      .where('createdAt', '<', ringCutoff)
      .limit(100)
      .get()

    let missed = 0
    for (const doc of unanswered.docs) {
      try {
        // A transaction, because the receiver may be tapping Accept at this
        // exact moment. Whoever wins, the loser sees a status that is no
        // longer `ringing` and stops — `acceptCall` refuses anything else.
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(doc.ref)
          if (!snap.exists) return
          if ((snap.data() as Record<string, any>).status !== 'ringing') return
          const call = snap.data() as Record<string, any>
          const stamp = admin.firestore.FieldValue.serverTimestamp()
          tx.update(doc.ref, {
            status: 'missed',
            endReason: 'no_answer',
            endedAt: stamp,
          })
          // Same history row `declineCall` writes, for the same reason: an
          // unanswered call is the single most useful thing a host can see
          // when they open the app, and it is the one that was invisible.
          tx.set(db.collection('callHistory').doc(doc.id), {
            ...call,
            callerUid: call.callerId,
            receiverUid: call.receiverId,
            status: 'missed',
            endReason: 'no_answer',
            endedAt: stamp,
            timestamp: stamp,
            durationSeconds: 0,
            diamondsCharged: 0,
            costDiamonds: 0,
            beansCredited: 0,
            beansEarned: 0,
            beneficiaryUid: call.earner ?? null,
            platformCut: 0,
          })
        })
        missed++
      } catch (err) {
        logger.error(`sweepStaleCalls: could not expire ring ${doc.id}`, err)
      }
    }

    if (closed > 0) logger.info(`sweepStaleCalls closed ${closed} call(s)`)
    if (missed > 0) logger.info(`sweepStaleCalls expired ${missed} unanswered ring(s)`)
    return null
  })

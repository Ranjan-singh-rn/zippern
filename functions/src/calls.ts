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
 * ── Idempotency ──────────────────────────────────────────────────────────────
 *
 * `tickIndex` on the call document is the count of ticks already charged. A
 * replayed tick sees its index is behind and charges nothing. Mobile networks
 * drop responses constantly; without this, every dropped response is a double
 * charge on a call that is already costing the user by the minute.
 */

const TICK_SECONDS = 10

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
import { assertActiveSession } from './mobileSession'


// ── startCall ────────────────────────────────────────────────────────────────

export const startCall = onCall(HOT, async (req: CallableRequest<StartCallRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const callerUid = context.auth?.uid
    if (!callerUid) throw new HttpsError('unauthenticated', 'Sign in to call.')
    // Auth-only guard. See functions/src/mobileSession.ts: refuses when the
    // caller presents a session id that is not the account's active one.
    await assertActiveSession(callerUid, data, 'startCall')

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

      const { perMin, pct, earner, payer } = rateFor(cfg, caller, peer)

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
       * asked before the phone rings instead of sixty seconds after.
       */
      const payerIsCaller = payer === 'caller'
      const payerUser = payerIsCaller ? caller : peer
      const balance = Number(payerUser.diamonds ?? 0)
      if (balance < perMin) {
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
        // Ticks charged so far. The server's only memory of what it has billed.
        tickIndex: 0,
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
 */
export const acceptCall = onCall(HOT, async (req: CallableRequest<CallIdRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const uid = context.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Not signed in.')
    const { callId } = data ?? {}
    if (!callId) throw new HttpsError('invalid-argument', 'callId is required.')

    const callRef = db.collection('calls').doc(callId)

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(callRef)
      if (!snap.exists) throw new HttpsError('not-found', 'That call no longer exists.')
      const call = snap.data() as Record<string, any>

      if (call.receiverId !== uid) {
        throw new HttpsError('permission-denied', 'This is not your call.')
      }
      // Idempotent: a double-tap on Accept returns the existing state rather
      // than resetting startedAt to now and discarding the elapsed time.
      if (call.status === 'connected') {
        return { callId, status: 'connected', alreadyConnected: true }
      }
      if (call.status !== 'ringing') {
        throw new HttpsError('failed-precondition', 'This call has already ended.')
      }

      const now = admin.firestore.FieldValue.serverTimestamp()
      tx.update(callRef, {
        status:     'connected',
        startedAt:  now,
        lastTickAt: now,   // so the watchdog has a baseline from the first second
      })
      return { callId, status: 'connected', alreadyConnected: false }
    })
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
        return { charged: 0, endNow: call.status === 'ended', status: call.status }
      }

      const startedAt: admin.firestore.Timestamp | null = call.startedAt ?? null
      if (!startedAt) return { charged: 0, endNow: false, status: call.status }

      // THE SERVER COMPUTES ELAPSED. Nothing the client sends is used.
      const elapsedSec = (Date.now() - startedAt.toMillis()) / 1000
      const ticksDue = Math.floor(elapsedSec / TICK_SECONDS)
      const ticksCharged = Number(call.tickIndex ?? 0)
      const outstanding = ticksDue - ticksCharged

      // A replayed tick lands here and charges nothing.
      if (outstanding <= 0) {
        return { charged: 0, endNow: false, status: call.status, tickIndex: ticksCharged }
      }

      const perMin = Number(call.perMinRateDiamonds ?? 0)
      const perTick = Math.ceil((perMin * TICK_SECONDS) / 60)
      const pct = Number(call.receiverPct ?? 50)

      const payerUid  = call.earner === 'caller' ? call.receiverId : call.callerId
      const earnerUid = call.earner === 'caller' ? call.callerId  : call.receiverId
      const payerRef  = db.collection('users').doc(payerUid)
      const earnerRef = db.collection('users').doc(earnerUid)

      const payerSnap = await tx.get(payerRef)
      const payerBalance = Number(payerSnap.get('diamonds') ?? 0)

      // Charge only what they can afford, then end the call.
      const affordableTicks = Math.min(outstanding, Math.floor(payerBalance / Math.max(perTick, 1)))
      const endNow = affordableTicks < outstanding

      if (affordableTicks <= 0) {
        tx.update(callRef, { status: 'ending', endReason: 'diamonds_exhausted' })
        return { charged: 0, endNow: true, status: 'ending', tickIndex: ticksCharged }
      }

      const diamonds = affordableTicks * perTick
      const beans = Math.floor((diamonds * pct) / 100)

      tx.update(payerRef,  { diamonds: admin.firestore.FieldValue.increment(-diamonds) })
      tx.update(earnerRef, {
        beans:            admin.firestore.FieldValue.increment(beans),
        totalBeansEarned: admin.firestore.FieldValue.increment(beans),
        hostCallEarnings: admin.firestore.FieldValue.increment(beans),
      })
      accrueWeeklyEarning(tx, earnerRef, beans, 'call')
      // Seconds, not calls: the call is counted once when it ends, but the
      // time has to accumulate as it passes, or a host watching Host Home
      // during a long call sees nothing move.
      //
      // No `isHost` gate and no level check here, both deliberately. This runs
      // every ten seconds for every call in progress, and either would mean
      // reading the earner's user document on each one — a read per tick per
      // call, to answer a question that does not change during a call. The
      // level is applied at endCall, which reads that document anyway, and the
      // nightly sweep is the backstop.
      accrueHostStats(tx, earnerRef, {
        beans,
        source: 'call',
        callSeconds: affordableTicks * TICK_SECONDS,
      })
      tx.update(callRef, {
        tickIndex:       ticksCharged + affordableTicks,
        diamondsCharged: admin.firestore.FieldValue.increment(diamonds),
        beansCredited:   admin.firestore.FieldValue.increment(beans),
        lastTickAt:      admin.firestore.FieldValue.serverTimestamp(),
        ...(endNow ? { status: 'ending', endReason: 'diamonds_exhausted' } : {}),
      })

      return {
        charged: diamonds,
        beans,
        endNow,
        status: endNow ? 'ending' : 'connected',
        tickIndex: ticksCharged + affordableTicks,
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
 */
async function settleAndClose(callId: string, byUid: string | null, reason: string) {
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
      return { alreadyEnded: true, diamondsCharged: call.diamondsCharged ?? 0 }
    }

    const startedAt: admin.firestore.Timestamp | null = call.startedAt ?? null
    const durationSeconds = startedAt ? Math.floor((Date.now() - startedAt.toMillis()) / 1000) : 0

    const payerUid  = call.earner === 'caller' ? call.receiverId : call.callerId
    const earnerUid = call.earner === 'caller' ? call.callerId  : call.receiverId
    const payerRef  = db.collection('users').doc(payerUid)
    const earnerRef = db.collection('users').doc(earnerUid)

    const [payerSnap, earnerSnap] = await Promise.all([tx.get(payerRef), tx.get(earnerRef)])

    // Any whole ticks elapsed but not yet billed. A partial tick is not charged
    // — billing for time not completed is the kind of thing users screenshot.
    const perMin  = Number(call.perMinRateDiamonds ?? 0)
    const perTick = Math.ceil((perMin * TICK_SECONDS) / 60)
    const pct     = Number(call.receiverPct ?? 50)
    const ticksDue     = startedAt ? Math.floor(durationSeconds / TICK_SECONDS) : 0
    const ticksCharged = Number(call.tickIndex ?? 0)
    const payerBalance = Number(payerSnap.get('diamonds') ?? 0)
    const finalTicks   = Math.max(0, Math.min(ticksDue - ticksCharged,
                                               Math.floor(payerBalance / Math.max(perTick, 1))))

    const finalDiamonds = finalTicks * perTick
    const finalBeans    = Math.floor((finalDiamonds * pct) / 100)

    const totalDiamonds = Number(call.diamondsCharged ?? 0) + finalDiamonds
    const totalBeans    = Number(call.beansCredited ?? 0) + finalBeans
    const now = admin.firestore.FieldValue.serverTimestamp()

    if (finalDiamonds > 0) {
      tx.update(payerRef,  { diamonds: admin.firestore.FieldValue.increment(-finalDiamonds) })
      tx.update(earnerRef, {
        beans:            admin.firestore.FieldValue.increment(finalBeans),
        totalBeansEarned: admin.firestore.FieldValue.increment(finalBeans),
        hostCallEarnings: admin.firestore.FieldValue.increment(finalBeans),
      })
      accrueWeeklyEarning(tx, earnerRef, finalBeans, 'call')
    }

    // The call itself is counted here, once, whether or not the last part-tick
    // earned anything — a call that ended mid-tick is still a call taken.
    if (earnerSnap.get('isHost') === true) {
      accrueHostStats(tx, earnerRef, {
        beans: finalBeans,
        source: 'call',
        callSeconds: finalTicks * TICK_SECONDS,
        calls: 1,
      })
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

    tx.update(callRef, {
      status: 'ended',
      endReason: reason,
      endedAt: now,
      durationSeconds,
      diamondsCharged: totalDiamonds,
      beansCredited: totalBeans,
      tickIndex: ticksCharged + finalTicks,
    })

    // ── Ledger. The gap that loses chargebacks. ─────────────────────────────
    // Calls previously wrote ELEVEN balance changes and not one ledger row.
    if (totalDiamonds > 0) {
      tx.set(payerRef.collection('diamondTransactions').doc(), {
        type: 'debit',
        amount: totalDiamonds,
        balanceAfter: payerBalance - finalDiamonds,
        reason: 'video_call',
        reasonLabel: `Video call — ${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`,
        relatedUid: earnerUid,
        relatedUserName: earnerSnap.get('displayName') ?? earnerSnap.get('name') ?? '',
        callId,
        durationSeconds,
        ratePerMin: perMin,
        context: 'call',
        timestamp: now,
      })
      tx.set(earnerRef.collection('beanTransactions').doc(), {
        type: 'credit',
        amount: totalBeans,
        balanceAfter: Number(earnerSnap.get('beans') ?? 0) + finalBeans,
        reason: 'video_call',
        reasonLabel: `Video call — ${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`,
        relatedUid: payerUid,
        relatedUserName: payerSnap.get('displayName') ?? payerSnap.get('name') ?? '',
        callId,
        durationSeconds,
        receiverPct: pct,
        context: 'call',
        timestamp: now,
      })
    }

    // CRM: reports.py:3443 scans platformRevenue for type == 'call'.
    // Field names are the ones it reads — renaming one drops it from the report.
    if (totalDiamonds > 0) {
      tx.set(db.collection('platformRevenue').doc(), {
        type: 'call',
        callerUid: call.callerId,
        receiverUid: call.receiverId,
        durationSeconds,
        grossDiamonds: totalDiamonds,
        payoutBeans: totalBeans,
        platformCut: totalDiamonds - totalBeans,
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
      endReason: reason,
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

    return { alreadyEnded: false, durationSeconds, diamondsCharged: totalDiamonds, beansCredited: totalBeans }
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
 * Two minutes past the last tick is twelve missed ticks — comfortably beyond a
 * tunnel or a lift, and well short of anything a user would notice.
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
 * ticks — and two minutes later the watchdog above settles the call and charges
 * the caller about twelve ticks for a conversation neither of them had, paying
 * the receiver for it.
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
        await settleAndClose(doc.id, null, 'watchdog_timeout')
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

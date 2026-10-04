import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https'
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
 * name. If this was already deployed as gen-1, delete it first:
 *   firebase functions:delete settleGift
 */
const MIN_INSTANCES = Number(process.env.WARM_INSTANCES ?? 0) || 0

const HOT = { region: 'asia-south1' as const, minInstances: MIN_INSTANCES }
import { accrueWeeklyEarning } from './payouts'
import { accrueHostStats, applyHostLevel, getHostLadder } from './hostStats'
import { assertActiveSession } from './mobileSession'

const db = admin.firestore()

/**
 * Gift settlement — the only path by which a gift may move money.
 *
 * ── Why this is a Cloud Function ─────────────────────────────────────────────
 *
 * The app used to deduct the sender's diamonds and credit the receiver's beans
 * from the client, in a Firestore batch. `firestore.rules` still concedes the
 * consequence in its own comment: a client that can write its own balance is a
 * client that can mint currency. The price came from the client too, so a
 * modified app could send a 20,000-diamond gift and be charged 1.
 *
 * Here, the client sends only *which* gift and *to whom*. Every number —
 * the price, the receiver's percentage, the beans credited — is read
 * server-side. Nothing the caller says about value is trusted.
 *
 * ── Why one transaction ──────────────────────────────────────────────────────
 *
 * A gift touches seven documents: two balances, the private record, two public
 * showcases, the pair aggregate and the fan total. If any subset could land
 * without the others, the public totals would drift from the ledger and there
 * would be no way to tell which was right. They commit together or not at all.
 */

const GIFT_CONTEXTS = ['live', 'call', 'dm', 'party'] as const
type GiftContext = typeof GIFT_CONTEXTS[number]

interface SettleGiftRequest {
  giftId: string
  receiverUid: string
  quantity: number
  context: GiftContext
  roomId?: string
  /**
   * Client-generated, stable across retries of the SAME user action.
   *
   * Mobile networks drop responses, and a gift button that has visibly done
   * nothing gets tapped again. Without this, the second tap is a second gift and
   * the user is charged twice for one intent.
   */
  idempotencyKey: string
}

/** Sorted, so a pair has exactly one document regardless of who sends first. */
function pairIdOf(a: string, b: string): string {
  return [a, b].sort().join('_')
}

export const settleGift = onCall(HOT, async (req: CallableRequest<SettleGiftRequest>) => {
    const data = req.data
    const context = { auth: req.auth }
    const senderUid = context.auth?.uid
    if (!senderUid) {
      throw new HttpsError('unauthenticated', 'Sign in to send a gift.')
    }
    // Auth-only guard. See functions/src/mobileSession.ts: refuses when the
    // caller presents a session id that is not the account's active one.
    await assertActiveSession(senderUid, data, 'settleGift')

    const { giftId, receiverUid, quantity, context: giftContext, roomId, idempotencyKey } = data ?? {}

    if (!giftId || typeof giftId !== 'string') {
      throw new HttpsError('invalid-argument', 'giftId is required.')
    }
    if (!receiverUid || typeof receiverUid !== 'string') {
      throw new HttpsError('invalid-argument', 'receiverUid is required.')
    }
    if (receiverUid === senderUid) {
      // Self-gifting would let a user cycle diamonds into beans at the receiver
      // percentage, which is a slow but real way to convert spend into payout.
      throw new HttpsError('invalid-argument', 'You cannot gift yourself.')
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new HttpsError('invalid-argument', 'quantity must be 1–9999.')
    }
    if (!GIFT_CONTEXTS.includes(giftContext)) {
      throw new HttpsError('invalid-argument', `context must be one of ${GIFT_CONTEXTS.join(', ')}.`)
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
      throw new HttpsError('invalid-argument', 'idempotencyKey is required.')
    }

    const senderRef   = db.collection('users').doc(senderUid)
    const receiverRef = db.collection('users').doc(receiverUid)
    const giftRef     = db.collection('gifts').doc(giftId)
    const configRef   = db.collection('appConfig').doc('economy')
    const claimRef    = db.collection('giftIdempotency').doc(`${senderUid}_${idempotencyKey}`)
    /*
     * Which collection the room lives in — decided by CONTEXT, not by hope.
     *
     * This line used to be `db.collection('liveRooms')` for every context, and
     * that single hardcoded name is what made party gifting look broken. A
     * party room is `partyRooms/{id}`; `liveRooms/{partyRoomId}` does not
     * exist, so `roomSnap.exists` was false, so the mirror block below was
     * skipped in full — silently, by design, because a missing ticker is
     * supposed to be a cosmetic loss.
     *
     * For a party it was not cosmetic. It was the ONLY record of the gift the
     * room could see: no gift animation (the overlay reads the subcollection),
     * no per-seat leaderboard (`seats.beansReceived` stayed 0), no room total
     * (`totalBeansEarned` stayed 0). The sender was debited, the recipient was
     * credited, and the room showed nothing at all — which reads to everyone
     * present as a gift that vanished.
     *
     * `dm` has no room and passes no roomId, which is why the ternary stays.
     */
    const roomCollection = giftContext === 'party' ? 'partyRooms' : 'liveRooms'
    // Read in the transaction so the room mirror can be skipped when the room
    // has already closed, rather than failing the update and rolling the whole
    // gift back. A gift that reaches the host but misses the ticker is a
    // cosmetic loss; one that throws after the money moved is not.
    const roomRef     = roomId ? db.collection(roomCollection).doc(String(roomId)) : null

    // Read before the transaction opens: it is ten-minute-cached config, and a
    // Firestore transaction forbids a read after its first write.
    const ladder = await getHostLadder()

    /*
     * In a party, the recipient is sitting in a numbered seat, and the seat is
     * what the room draws. Found here — before the transaction writes anything,
     * because Firestore forbids a read after a write — so the seat's running
     * total can be incremented alongside the room's.
     *
     * By uid rather than by seat index: the client knows who it is gifting, and
     * asking it which seat that person occupies would be one more number it
     * could get wrong or lie about.
     */
    const seatQuery = giftContext === 'party' && roomRef
      ? roomRef.collection('seats').where('uid', '==', receiverUid).limit(1)
      : null

    return db.runTransaction(async (tx) => {
      // ── Every read first. Firestore forbids a read after a write. ───────────
      const [claimSnap, senderSnap, receiverSnap, giftSnap, configSnap, roomSnap, seatSnap] = await Promise.all([
        tx.get(claimRef),
        tx.get(senderRef),
        tx.get(receiverRef),
        tx.get(giftRef),
        tx.get(configRef),
        roomRef ? tx.get(roomRef) : Promise.resolve(null),
        seatQuery ? tx.get(seatQuery) : Promise.resolve(null),
      ])

      // Replay of a request we already settled: return the original result
      // rather than charging again.
      if (claimSnap.exists) {
        const prior = claimSnap.data() as Record<string, unknown>
        return { ...prior, replayed: true }
      }

      if (!senderSnap.exists)   throw new HttpsError('not-found', 'Sender account not found.')
      /*
       * A banned account cannot spend.
       *
       * There was no ban check here at all, so somebody barred from the app
       * could still move money through it with a token they already held — and
       * the gift would credit a host, hit the ledger and appear in the reports
       * as ordinary revenue.
       */
      if (senderSnap.get('isBanned') === true) {
        throw new HttpsError('permission-denied', 'This account is restricted.')
      }
      if (!receiverSnap.exists) throw new HttpsError('not-found', 'Recipient not found.')
      if (!giftSnap.exists)     throw new HttpsError('not-found', 'That gift no longer exists.')

      const gift = giftSnap.data() as Record<string, any>

      // ── Field names come from the CRM, not from what reads nicely ──────────
      //
      // zipper-crm/app/gifts/page.tsx writes: name, emoji, imageUrl,
      // lottieAsset, diamondCost, earningRate, category, isActive, sortOrder.
      // Reading `priceDiamonds` here would have made Number(undefined) = NaN
      // and thrown "has no usable price" on every single gift in the app, and
      // checking `active` would have let a gift the CRM had switched off keep
      // selling. `priceDiamonds` / `displayName` / `iconUrl` are accepted as
      // fallbacks only so a hand-seeded doc still works.
      if (gift.isActive === false || gift.active === false) {
        throw new HttpsError('failed-precondition', 'That gift is no longer available.')
      }

      // PRICE COMES FROM THE SERVER. The client never sends a cost.
      const unitPrice = Number(gift.diamondCost ?? gift.priceDiamonds)
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new HttpsError('internal', `Gift ${giftId} has no usable price.`)
      }
      const totalCost = unitPrice * quantity

      // ── Receiver share ─────────────────────────────────────────────────────
      //
      // The CRM sets `earningRate` per gift — Rose 50, Crown 52, Rocket 55,
      // Lucky Box 5 — and shows the operator the resulting host cut and Zipper
      // margin on the same screen. That per-gift number is the decision that
      // was actually made, so it wins. The category rate in appConfig is the
      // fallback for gifts seeded before the field existed.
      const cfg = (configSnap.data() ?? {}) as Record<string, any>
      const rates = (cfg.giftRates ?? {}) as Record<string, any>
      const category: string = gift.category ?? 'normal'
      const perGiftRate = Number(gift.earningRate)
      const pct = Number.isFinite(perGiftRate) && perGiftRate > 0 && perGiftRate <= 100
        ? perGiftRate
        : receiverPctFor(category, rates)

      const senderData = senderSnap.data() as Record<string, any>

      const senderDiamonds = Number(senderData.diamonds ?? 0)
      if (senderDiamonds < totalCost) {
        throw new HttpsError(
          'failed-precondition',
          `Not enough diamonds. This costs ${totalCost}, you have ${senderDiamonds}.`,
        )
      }

      // Floor, not round: never credit a bean that was not paid for.
      const beansCredited = Math.floor((totalCost * pct) / 100)

      const now     = admin.firestore.FieldValue.serverTimestamp()
      const txRef   = db.collection('giftTransactions').doc()
      const pairRef = db.collection('giftPairs').doc(pairIdOf(senderUid, receiverUid))
        .collection('gifts').doc(giftId)
      const senderShowcaseRef   = senderRef.collection('giftShowcase').doc(giftId)
      const receiverShowcaseRef = receiverRef.collection('giftShowcase').doc(giftId)
      const fanRef              = receiverRef.collection('topFans').doc(senderUid)

      const senderIsA = [senderUid, receiverUid].sort()[0] === senderUid

      // ── Writes ─────────────────────────────────────────────────────────────

      tx.update(senderRef, {
        diamonds:       admin.firestore.FieldValue.increment(-totalCost),
        totalGemsSpent: admin.firestore.FieldValue.increment(totalCost),
      })
      tx.update(receiverRef, {
        beans:                admin.firestore.FieldValue.increment(beansCredited),
        totalBeansEarned:     admin.firestore.FieldValue.increment(beansCredited),
        hostGiftEarnings:     admin.firestore.FieldValue.increment(beansCredited),
        totalGiftsReceived:   admin.firestore.FieldValue.increment(quantity),
      })

      // Bank the earning against this IST week, for the one-week-in-arrears
      // release. Same transaction as the credit — they must not diverge.
      accrueWeeklyEarning(tx, receiverRef, beansCredited, 'gift')

      // Host Home's "today", and the level ladder. Same transaction as the
      // credit — a daily total that disagreed with the wallet would be
      // believed over the wallet, because it is the bigger, newer number.
      if (receiverSnap.get('isHost') === true) {
        accrueHostStats(tx, receiverRef, {
          beans: beansCredited,
          source: 'gift',
          giftsReceived: quantity,
        })
        applyHostLevel(
          tx,
          receiverRef,
          Number(receiverSnap.get('hostLevel') ?? 0),
          Number(receiverSnap.get('hostCallEarnings') ?? 0) +
            Number(receiverSnap.get('hostGiftEarnings') ?? 0) +
            beansCredited,
          ladder,
        )
      }

      // PRIVATE. Readable only by the two parties (see firestore.rules).
      tx.set(txRef, {
        senderUid, receiverUid, giftId,
        giftName:      gift.name ?? gift.displayName ?? giftId,
        quantity,
        unitPrice,
        diamondCost:   totalCost,
        beansCredited,
        receiverPct:   pct,
        category,
        context:       giftContext,
        roomId:        roomId ?? null,
        createdAt:     now,
      })

      // PUBLIC, anonymous. Counts only — no uid, no timestamp, nothing that
      // could identify a counterparty.
      // `emoji` matters: a CRM gift saved in emoji mode has no imageUrl, and
      // without it the profile rendered every gift as the same grey box.
      tx.set(senderShowcaseRef, {
        giftId,
        displayName: gift.name ?? gift.displayName ?? giftId,
        iconUrl:     gift.imageUrl ?? gift.iconUrl ?? '',
        emoji:       gift.emoji ?? '',
        sentCount:   admin.firestore.FieldValue.increment(quantity),
      }, { merge: true })
      tx.set(receiverShowcaseRef, {
        giftId,
        displayName:   gift.name ?? gift.displayName ?? giftId,
        iconUrl:       gift.imageUrl ?? gift.iconUrl ?? '',
        emoji:         gift.emoji ?? '',
        receivedCount: admin.firestore.FieldValue.increment(quantity),
      }, { merge: true })

      // PAIRWISE. Powers the "you sent this 2x" highlight, readable only by
      // the two people in it.
      tx.set(pairRef, {
        giftId,
        aToBCount: admin.firestore.FieldValue.increment(senderIsA ? quantity : 0),
        bToACount: admin.firestore.FieldValue.increment(senderIsA ? 0 : quantity),
        lastAt:    now,
      }, { merge: true })

      // PUBLIC, named — how much, never which gift.
      tx.set(fanRef, {
        fanUid:        senderUid,
        displayName:   senderData.displayName ?? senderData.name ?? '',
        photoUrl:      senderData.photoUrl ?? '',
        totalDiamonds: admin.firestore.FieldValue.increment(totalCost),
        lastGiftAt:    now,
      }, { merge: true })

      // ── Ledger ─────────────────────────────────────────────────────────────
      //
      // Written for a chargeback file, not a history screen. When a user
      // recharges and then asks the gateway for their money back, the defence is
      // showing the diamonds were consumed: this gift, at this time, to this
      // account, leaving this balance.
      //
      // Three fields the old client-side row lacked and a dispute needs:
      //   relatedUid   — the existing row stored relatedUserName only, and a
      //                  display name is not an identifier. Names change and
      //                  repeat; "he sent it to Priya" proves nothing.
      //   balanceAfter — without a running balance you cannot reconstruct the
      //                  timeline, only assert it.
      //   context      — where it happened, so the gift ties to a real session.
      tx.set(senderRef.collection('diamondTransactions').doc(), {
        type: 'debit',
        amount: totalCost,
        balanceAfter: senderDiamonds - totalCost,
        reason: 'gift_sent',
        reasonLabel: `Gift sent — ${gift.name ?? gift.displayName ?? giftId} x${quantity}`,
        relatedUid: receiverUid,
        relatedUserName: receiverSnap.get('displayName') ?? receiverSnap.get('name') ?? '',
        giftId,
        quantity,
        context: giftContext,
        roomId: roomId ?? null,
        transactionId: txRef.id,
        timestamp: now,
      })

      tx.set(receiverRef.collection('beanTransactions').doc(), {
        type: 'credit',
        amount: beansCredited,
        balanceAfter: Number(receiverSnap.get('beans') ?? 0) + beansCredited,
        reason: 'gift_received',
        reasonLabel: `Gift received — ${gift.name ?? gift.displayName ?? giftId} x${quantity}`,
        relatedUid: senderUid,
        relatedUserName: senderData.displayName ?? senderData.name ?? '',
        giftId,
        quantity,
        diamondCost: totalCost,
        receiverPct: pct,
        context: giftContext,
        roomId: roomId ?? null,
        transactionId: txRef.id,
        timestamp: now,
      })

      // ── CRM integration ────────────────────────────────────────────────────
      //
      // The FastAPI backend builds every gift figure in the weekly and monthly
      // reports by scanning these two collections — not giftTransactions. Moving
      // settlement here WITHOUT writing them would have zeroed the CRM's gift
      // revenue while the app carried on working, and nobody would have noticed
      // until a report looked wrong.
      //
      // Field names are the ones reports.py reads, verbatim. Renaming one here
      // silently drops it from the report rather than erroring.
      //   giftEvents      -> backend/app/services/reports.py:_gift_events
      //   platformRevenue -> backend/app/services/reports.py:3443

      // The live-room ticker also listens on giftEvents, which is why roomId
      // stays on it: the rule makes an in-room gift public and everything else
      // private to the two parties.
      tx.set(db.collection('giftEvents').doc(), {
        senderUid, receiverUid,
        giftId,
        giftName:   gift.name ?? gift.displayName ?? giftId,
        giftType:   category,
        perGiftCost: unitPrice,
        quantity,
        totalCost,
        beansEarned: beansCredited,
        imageUrl:   gift.imageUrl ?? gift.iconUrl ?? '',
        lottieAsset: gift.lottieAsset ?? '',
        roomId:     roomId ?? '',
        timestamp:  now,
      })

      // Room mirror — the live ticker and the in-room gift leaderboard read
      // `liveRooms/{roomId}/gifts`, not `giftEvents`. The client used to write
      // this row itself, which meant `diamondCost` on the leaderboard was
      // whatever the client claimed: a modified app could top the board for
      // free. Written here, the board reflects money that actually moved.
      if (roomRef && roomSnap?.exists) {
        tx.set(roomRef.collection('gifts').doc(), {
          uid:         senderUid,
          senderName:  senderData.displayName ?? senderData.name ?? '',
          senderPhotoUrl: senderData.photoUrl ?? '',
          giftName:    gift.name ?? gift.displayName ?? giftId,
          giftId,
          emoji:       gift.emoji ?? '',
          imageUrl:    gift.imageUrl ?? gift.iconUrl ?? '',
          quantity,
          diamondCost: totalCost,
          // Millis, not serverTimestamp: liveGiftsFlow orders on this field and
          // deserialises it into a Long. A Timestamp here breaks both.
          timestamp:   Date.now(),
        })

        tx.update(roomRef, {
          totalGiftsReceived: admin.firestore.FieldValue.increment(quantity),
          totalBeansEarned:   admin.firestore.FieldValue.increment(beansCredited),
        })

        /*
         * The seat's own total, for the in-room leaderboard.
         *
         * `PartySeat.beansReceived` has existed on the model since the room was
         * first built and no code has ever incremented it, so every seat has
         * always shown zero. This is that writer.
         *
         * Skipped without complaint when the seat is gone — the recipient may
         * have stood up between the tap and the commit, and the money has
         * already reached their account either way. Losing a leaderboard row is
         * not worth failing a settled gift over.
         */
        if (seatSnap && !seatSnap.empty) {
          tx.update(seatSnap.docs[0].ref, {
            beansReceived: admin.firestore.FieldValue.increment(beansCredited),
          })
        }
      }

      // Zipper's cut is what the sender paid minus what the receiver earned.
      // Derived here rather than trusted from anywhere, so the ledger and the
      // revenue line can never disagree.
      tx.set(db.collection('platformRevenue').doc(), {
        type:          'gift',
        subType:       category,
        quantity,
        perGiftCost:   unitPrice,
        grossDiamonds: totalCost,
        payoutBeans:   beansCredited,
        platformCut:   totalCost - beansCredited,
        senderUid, receiverUid,
        roomId:        roomId ?? '',
        transactionId: txRef.id,
        timestamp:     now,
      })

      const result = {
        transactionId: txRef.id,
        totalCost,
        beansCredited,
        receiverPct: pct,
        quantity,
      }

      // Claim last, so a crash mid-transaction leaves nothing claimed.
      tx.set(claimRef, { ...result, senderUid, receiverUid, giftId, createdAt: now })

      return { ...result, replayed: false }
    })
  })

/**
 * Receiver share for a gift category, from the CRM's configured rates.
 *
 * Exclusive gifts are configured as a min/max band. The midpoint is used here
 * rather than a roll: a per-transaction random share would make a host's
 * earnings unpredictable for no benefit to anyone, and the lucky mechanic
 * already exists for gifts that are meant to be a gamble.
 */
function receiverPctFor(category: string, rates: Record<string, any>): number {
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback

  switch ((category || 'normal').toLowerCase()) {
    case 'exclusive': {
      const lo = num(rates.exclusiveReceiverPctMin, 50)
      const hi = num(rates.exclusiveReceiverPctMax, 55)
      return Math.floor((lo + hi) / 2)
    }
    case 'lucky':
      return num(rates.luckyReceiverPct, 50)
    default:
      return num(rates.normalReceiverPct, 50)
  }
}

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { IST_OFFSET_MIN, istWeekKey } from './time'

const db = admin.firestore()

/**
 * Payout hold — earnings are released one week in arrears.
 *
 * ── The exposure ─────────────────────────────────────────────────────────────
 *
 * When a user recharges, spends, and then wins a refund or a chargeback, you
 * lose the money twice: once returning it to the user, and again because the
 * host was already credited beans for the gift — possibly already paid out.
 *
 * Three options were considered. Clawing back from a host who has already been
 * paid is indistinguishable from theft to the host, and hosts talk. Absorbing it
 * is invisible until volume makes it expensive. **Holding is the standard
 * answer**, and it costs the host patience rather than money.
 *
 * ── Why one week, and why this is cheap to build ─────────────────────────────
 *
 * Payouts are already weekly and already close at 23:59 IST Sunday
 * (`29 18 * * 0` UTC — verified, not assumed). So the hold is not a new
 * mechanism: week N's earnings are simply released for withdrawal at the end of
 * week N+1. A Monday gift waits about thirteen days, a Sunday one about seven.
 *
 * ── The three numbers a host sees ────────────────────────────────────────────
 *
 *   beans             total balance — spendable and convertible now
 *   beansAvailable    released, withdrawable
 *   (beans - available) pending, with a release date
 *
 * Three honest numbers beat one that sometimes cannot be withdrawn and does not
 * say why. **The payout screen must show all three from day one.** A host used
 * to weekly money will read a silent delay as non-payment.
 */

// Day and week keys live in ./time — they were defined separately here and in
// wallet.ts, each with its own offset constant, which is two chances for a
// date boundary to drift apart.
export { istWeekKey } from './time'

/**
 * Records beans earned into the current IST week's bucket.
 *
 * Called from settleGift and the call functions inside their transaction, so a
 * credit and its week record commit together. If they could diverge, the weekly
 * release would pay an amount that never matched the ledger.
 */
export function accrueWeeklyEarning(
  tx: admin.firestore.Transaction,
  userRef: admin.firestore.DocumentReference,
  beans: number,
  source: 'gift' | 'call',
) {
  if (beans <= 0) return
  const weekKey = istWeekKey()
  tx.set(
    userRef.collection('weeklyEarnings').doc(weekKey),
    {
      weekKey,
      beans: admin.firestore.FieldValue.increment(beans),
      [`${source}Beans`]: admin.firestore.FieldValue.increment(beans),
      released: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

/**
 * Releases the previous completed week for withdrawal.
 *
 * Monday 00:30 IST — half an hour after the payout period closes at 23:59
 * Sunday, so the week's final gifts have certainly landed.
 *
 * A week is skipped, not lost, when the host is unverified or has an open
 * dispute. Skipping leaves `released: false`, so the next run picks it up once
 * the block clears and the host is paid everything they earned.
 */
export const releaseBeansForWeek = functions
  .region('asia-south1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('30 0 * * 1')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    // The week that closed last night, plus any earlier week still unreleased
    // because the host was blocked at the time.
    const cutoff = istWeekKey(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))

    const pending = await db.collectionGroup('weeklyEarnings')
      .where('released', '==', false)
      .where('weekKey', '<=', cutoff)
      .limit(500)
      .get()

    // One read for the whole run. Every statement in this batch is settled at
    // the same rate, which is also what makes a week's figure reproducible.
    const cfgSnap = await db.collection('appConfig').doc('economy').get()
    const rateInr = Number(
      (cfgSnap.get('giftRates') as Record<string, any> | undefined)?.beanToInrRate ?? 0.01,
    )

    let released = 0, skipped = 0, beansTotal = 0

    for (const doc of pending.docs) {
      const userRef = doc.ref.parent.parent
      if (!userRef) continue
      const beans = Number(doc.get('beans') ?? 0)
      if (beans <= 0) {
        await doc.ref.update({ released: true, releasedAt: admin.firestore.FieldValue.serverTimestamp() })
        continue
      }

      try {
        await db.runTransaction(async (tx) => {
          const userSnap = await tx.get(userRef)
          if (!userSnap.exists) return

          // Unverified hosts accrue but are not paid. Sending money to an
          // identity nobody has confirmed is the exposure India's AML rules
          // exist for, and it is also the strongest reason to get verified.
          if (userSnap.get('isVerifiedHost') !== true) {
            throw new Error('SKIP_UNVERIFIED')
          }
          if (userSnap.get('payoutHold') === true) {
            throw new Error('SKIP_HOLD')
          }

          tx.update(userRef, {
            beansAvailable: admin.firestore.FieldValue.increment(beans),
          })
          tx.update(doc.ref, {
            released: true,
            releasedAt: admin.firestore.FieldValue.serverTimestamp(),
            skippedReason: admin.firestore.FieldValue.delete(),
          })
          tx.set(userRef.collection('beanTransactions').doc(), {
            type: 'release',
            amount: beans,
            reason: 'weekly_release',
            reasonLabel: `Earnings for ${doc.get('weekKey')} released for withdrawal`,
            weekKey: doc.get('weekKey'),
            context: 'payout',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          })

          // ── The statement ───────────────────────────────────────────────
          //
          // `weeklyStatements`, not `hostPayouts`: a top-level `hostPayouts`
          // collection already exists for the CRM's weekly payout report, and
          // two different things under one name is how somebody later reads the
          // wrong rule and grants finance access to a host's own subcollection.
          //
          // A host asking "why is this week ₹4,200 and last week ₹5,100" needs
          // the split, not a total. Gift beans, call beans, and what they
          // converted away — the converted figure especially, because those
          // beans left the payout pool by the host's own choice and its
          // absence is the most common reason a week looks short.
          //
          // Written at release rather than assembled on demand: the rate can
          // change, and a statement that silently revalues a settled week is
          // worse than no statement.
          const weekKey = String(doc.get('weekKey'))
          tx.set(
            userRef.collection('weeklyStatements').doc(weekKey),
            {
              weekKey,
              status: 'released',
              beansReleased: beans,
              giftBeans: Number(doc.get('giftBeans') ?? 0),
              callBeans: Number(doc.get('callBeans') ?? 0),
              //: Beans earned this week that the host converted to diamonds.
              //: They are not payable — see convertBeans — and the statement
              //: says so rather than leaving an unexplained shortfall.
              convertedBeans: Number(doc.get('convertedBeans') ?? 0),
              beanToInrRate: rateInr,
              amountInr: Math.round(beans * rateInr * 100) / 100,
              releasedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          )
        })
        released++
        beansTotal += beans
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.startsWith('SKIP_')) {
          skipped++
          // Outside the transaction, on purpose. The SKIP_ throw is how the
          // release is abandoned, and it rolls back everything the transaction
          // did — so a statement written inside it would never survive. The
          // first version of this did exactly that, and the held weeks would
          // have been invisible to the host they were being held from.
          const why = msg === 'SKIP_UNVERIFIED' ? 'unverified' : 'dispute_hold'
          const weekKey = String(doc.get('weekKey'))
          try {
            await Promise.all([
              doc.ref.update({
                skippedReason: why,
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              userRef.collection('weeklyStatements').doc(weekKey).set(
                {
                  weekKey,
                  status: 'held',
                  heldReason: why,
                  beansPending: beans,
                  giftBeans: Number(doc.get('giftBeans') ?? 0),
                  callBeans: Number(doc.get('callBeans') ?? 0),
                  convertedBeans: Number(doc.get('convertedBeans') ?? 0),
                  //: Held, not lost. The next run picks this week up once the
                  //: block clears, and the host is paid all of it. Saying so
                  //: is the difference between an instruction and a loss.
                  willReleaseWhenCleared: true,
                  lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true },
              ),
            ])
          } catch (writeErr) {
            functions.logger.error(`releaseBeansForWeek: could not mark ${doc.ref.path} held`, writeErr)
          }
          continue
        }
        functions.logger.error(`releaseBeansForWeek: ${doc.ref.path}`, err)
      }
    }

    functions.logger.info(
      `releaseBeansForWeek: released ${released} week(s) totalling ${beansTotal} beans; ${skipped} skipped`,
    )
    return null
  })

/**
 * What a host may withdraw right now, and why the rest is not available yet.
 *
 * The payout screen calls this. It deliberately returns the pending amount and
 * its release date alongside the available figure — a screen that shows only
 * what is withdrawable, with no explanation of the gap, is how a hold gets read
 * as non-payment.
 */
export const getPayoutStatus = functions
  .region('asia-south1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const userRef = db.collection('users').doc(uid)
    const [userSnap, weeksSnap] = await Promise.all([
      userRef.get(),
      userRef.collection('weeklyEarnings').where('released', '==', false).get(),
    ])
    if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')

    const pending = weeksSnap.docs.map((d) => ({
      weekKey: d.get('weekKey'),
      beans: Number(d.get('beans') ?? 0),
      skippedReason: d.get('skippedReason') ?? null,
    }))

    // Next Monday 00:30 IST.
    const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000)
    const daysToMonday = (8 - (nowIst.getUTCDay() || 7)) % 7 || 7
    const release = new Date(nowIst)
    release.setUTCDate(release.getUTCDate() + daysToMonday)
    release.setUTCHours(0, 30, 0, 0)

    return {
      beans: Number(userSnap.get('beans') ?? 0),
      beansAvailable: Number(userSnap.get('beansAvailable') ?? 0),
      beansPending: pending.reduce((n, w) => n + w.beans, 0),
      pendingWeeks: pending,
      nextReleaseAt: release.getTime() - IST_OFFSET_MIN * 60 * 1000,
      isVerifiedHost: userSnap.get('isVerifiedHost') === true,
      payoutHold: userSnap.get('payoutHold') === true,
    }
  })

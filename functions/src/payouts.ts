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
 * What the job actually does is set by `appConfig/economy.payoutReleaseArrearsWeeks`
 * (OWNER_DECISION_PENDING, see `payoutReleaseArrearsWeeks` below): 1 is the
 * hold described here; 0, the default and the behaviour so far, releases week
 * N on the Monday it closes.
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
 *
 * ── M-3 / F-2 (FINANCE-007): the week document is read INSIDE the transaction
 *
 * The amount used to come from the query's snapshot and the transaction read
 * only the user document, so Firestore had nothing to detect a conflict on:
 * a second overlapping run (Scheduler delivers at least once; a manual re-run
 * is one click) released the same week twice, and a `convertBeans` that drew
 * the week down between the query and the transaction was ignored, releasing
 * beans the host had already turned into diamonds. `beansAvailable` is exactly
 * what the withdrawal pays against. Now the week is re-read with `tx.get`,
 * a week already `released` is left alone, and the FRESH `beans` figure is
 * what is released. (`convertBeans` decrements `beans` and tracks the amount
 * in `convertedBeans`, so `beans` is already net of conversions; it is used
 * as is, and `convertedBeans` goes on the statement.)
 *
 * ── Pagination ───────────────────────────────────────────────────────────────
 *
 * A single `limit(500)` left the 501st pending week for next Monday. The
 * query is now walked with a cursor until it comes back empty. Held weeks
 * stay `released: false` and would be returned again on every page, which is
 * why the cursor — not "query again" — is what moves the walk forward.
 */
const RELEASE_PAGE_SIZE = 500

/**
 * M-5 / F-22, OWNER_DECISION_PENDING: how many whole weeks a closed earnings
 * week waits, beyond today's release, before it becomes withdrawable.
 *
 * Read from `appConfig/economy.payoutReleaseArrearsWeeks` at the start of every
 * run, as an integer >= 0:
 *
 *   0  the default, and what an absent field means: TODAY'S BEHAVIOUR. The
 *      Monday 00:30 IST run releases the ISO week that closed half an hour
 *      earlier, so an earning is held between 30 minutes and 7 days.
 *   1  one week in arrears, as the header above and BACKEND-DESIGN.md § 3.4
 *      describe: week N is released by the run after week N+1 closes, a hold
 *      of about 7 to 14 days, so a chargeback lands while the beans are held.
 *   n  the cutoff moves back n weeks.
 *
 * A value that is not a whole number from 0 to MAX_PAYOUT_RELEASE_ARREARS_WEEKS
 * is treated as 0 (today's behaviour, never a silent payout freeze) and the
 * run logs an error naming it.
 *
 * The owner has not decided the policy (system audit 1 Nov 2026, M-5 / F-22,
 * open question 4). The backend publishes the same flag at
 * GET /api/reports/payout-policy (`PAYOUT_RELEASE_ARREARS_WEEKS` in
 * backend/app/config.py), which is the figure the CRM and the app show; this
 * field is the one that releases money. They are separate settings: change
 * both together, or hosts are told one date and paid on another.
 *
 * Raising it holds weeks that would otherwise be released (nothing already
 * released is touched; a held week is taken by the first run whose cutoff
 * reaches it). Lowering it releases what it was holding on the next run.
 */
export const PAYOUT_RELEASE_ARREARS_FIELD = 'payoutReleaseArrearsWeeks'
export const MAX_PAYOUT_RELEASE_ARREARS_WEEKS = 52
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** The configured arrears; 0 and `valid: false` for anything that is not a whole number in range. */
export function payoutReleaseArrearsWeeks(raw: unknown): { weeks: number; valid: boolean } {
  if (raw === undefined || raw === null) return { weeks: 0, valid: true }
  if (
    typeof raw === 'number' && Number.isInteger(raw) &&
    raw >= 0 && raw <= MAX_PAYOUT_RELEASE_ARREARS_WEEKS
  ) {
    return { weeks: raw, valid: true }
  }
  return { weeks: 0, valid: false }
}

/**
 * The newest IST week a run at `nowMs` may release: the week containing
 * `now - 7 days`, moved back `arrearsWeeks` more weeks. With 0 this is exactly
 * the cutoff the job has always used.
 */
export function releaseCutoffWeekKey(nowMs: number, arrearsWeeks: number): string {
  return istWeekKey(new Date(nowMs - (1 + arrearsWeeks) * WEEK_MS))
}

export const releaseBeansForWeek = functions
  .region('asia-south1')
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('30 0 * * 1')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    // One read for the whole run. Every statement in this batch is settled at
    // the same rate, which is also what makes a week's figure reproducible.
    const cfgSnap = await db.collection('appConfig').doc('economy').get()
    const rateInr = Number(
      (cfgSnap.get('giftRates') as Record<string, any> | undefined)?.beanToInrRate ?? 0.01,
    )

    // The week that closed last night (or, with an arrears hold configured,
    // the week that closed that many weeks before it), plus any earlier week
    // still unreleased because the host was blocked at the time.
    // OWNER_DECISION_PENDING: see `payoutReleaseArrearsWeeks` above.
    const rawArrears = cfgSnap.get(PAYOUT_RELEASE_ARREARS_FIELD)
    const arrears = payoutReleaseArrearsWeeks(rawArrears)
    if (!arrears.valid) {
      functions.logger.error(
        `releaseBeansForWeek: appConfig/economy.${PAYOUT_RELEASE_ARREARS_FIELD} is ` +
        `${String(JSON.stringify(rawArrears)).slice(0, 80)}, not a whole number from 0 to ` +
        `${MAX_PAYOUT_RELEASE_ARREARS_WEEKS}; released with the default of 0 weeks in arrears.`,
      )
    }
    const cutoff = releaseCutoffWeekKey(Date.now(), arrears.weeks)

    let released = 0, skipped = 0, beansTotal = 0, seen = 0
    let cursor: admin.firestore.QueryDocumentSnapshot | null = null

    // Page by cursor until the query comes back empty. Held weeks stay
    // `released: false` and would be returned again by a plain re-query;
    // the cursor is what moves past them.
    for (;;) {
      let query = db.collectionGroup('weeklyEarnings')
        .where('released', '==', false)
        .where('weekKey', '<=', cutoff)
        .orderBy('weekKey')
        .limit(RELEASE_PAGE_SIZE)
      if (cursor) query = query.startAfter(cursor)
      const page = await query.get()
      if (page.empty) break
      cursor = page.docs[page.docs.length - 1]
      seen += page.size

      for (const doc of page.docs) {
        const outcome = await releaseWeek(doc, rateInr)
        if (outcome.kind === 'released') {
          released++
          beansTotal += outcome.beans
        } else if (outcome.kind === 'held') {
          skipped++
        }
      }

      if (page.size < RELEASE_PAGE_SIZE) break
    }

    functions.logger.info(
      `releaseBeansForWeek: released ${released} week(s) totalling ${beansTotal} beans; ` +
      `${skipped} skipped; ${seen} pending week(s) examined; cutoff ${cutoff} ` +
      `(${arrears.weeks} week(s) in arrears)`,
    )
    return null
  })

type ReleaseOutcome =
  | { kind: 'released'; beans: number }
  | { kind: 'already' | 'no_user' | 'empty' | 'held' | 'failed' }

/**
 * One week's release, as one transaction. Returns what happened rather than
 * throwing, so the page loop can count and carry on.
 */
async function releaseWeek(
  doc: admin.firestore.QueryDocumentSnapshot,
  rateInr: number,
): Promise<ReleaseOutcome> {
  const userRef = doc.ref.parent.parent
  if (!userRef) return { kind: 'no_user' }

  try {
    return await db.runTransaction(async (tx): Promise<ReleaseOutcome> => {
      // The week document itself, fresh: this is what makes the release
      // transactional. Anything that changed it since the query — another run
      // of this job, a conversion — is seen here, or aborts the commit.
      const [userSnap, weekSnap] = await Promise.all([tx.get(userRef), tx.get(doc.ref)])
      if (!weekSnap.exists || weekSnap.get('released') === true) return { kind: 'already' }
      if (!userSnap.exists) return { kind: 'no_user' }

      const beans = Number(weekSnap.get('beans') ?? 0)
      if (beans <= 0) {
        tx.update(doc.ref, { released: true, releasedAt: admin.firestore.FieldValue.serverTimestamp() })
        return { kind: 'empty' }
      }

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
        reasonLabel: `Earnings for ${weekSnap.get('weekKey')} released for withdrawal`,
        weekKey: weekSnap.get('weekKey'),
        context: 'payout',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      })

      // ── The statement ─────────────────────────────────────────────────────
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
      const weekKey = String(weekSnap.get('weekKey'))
      tx.set(
        userRef.collection('weeklyStatements').doc(weekKey),
        {
          weekKey,
          status: 'released',
          beansReleased: beans,
          giftBeans: Number(weekSnap.get('giftBeans') ?? 0),
          callBeans: Number(weekSnap.get('callBeans') ?? 0),
          //: Beans earned this week that the host converted to diamonds.
          //: They are not payable — see convertBeans — and the statement
          //: says so rather than leaving an unexplained shortfall.
          convertedBeans: Number(weekSnap.get('convertedBeans') ?? 0),
          beanToInrRate: rateInr,
          amountInr: Math.round(beans * rateInr * 100) / 100,
          releasedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      return { kind: 'released', beans }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.startsWith('SKIP_')) {
      functions.logger.error(`releaseBeansForWeek: ${doc.ref.path}`, err)
      return { kind: 'failed' }
    }
    // Outside the transaction, on purpose. The SKIP_ throw is how the
    // release is abandoned, and it rolls back everything the transaction
    // did — so a statement written inside it would never survive. The
    // first version of this did exactly that, and the held weeks would
    // have been invisible to the host they were being held from.
    const why = msg === 'SKIP_UNVERIFIED' ? 'unverified' : 'dispute_hold'
    const weekKey = String(doc.get('weekKey'))
    try {
      // Re-read rather than reuse the query's figure: the hold statement
      // says what is pending NOW, and the week may have moved since.
      const fresh = await doc.ref.get()
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
            beansPending: Number(fresh.get('beans') ?? 0),
            giftBeans: Number(fresh.get('giftBeans') ?? 0),
            callBeans: Number(fresh.get('callBeans') ?? 0),
            convertedBeans: Number(fresh.get('convertedBeans') ?? 0),
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
    return { kind: 'held' }
  }
}

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

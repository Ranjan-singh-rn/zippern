import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import { istDateKey } from './time'
import { assertActiveSession } from './mobileSession'

const db = admin.firestore()

/**
 * The remaining money paths: bean conversion, daily rewards, bag purchases.
 *
 * Each replaces a client-side balance write. All three follow the same shape as
 * settleGift and the call functions: the client asks for an outcome, the server
 * decides the price and records the movement.
 */

/** Today's date key in IST. Every reset in this product is IST midnight. */

// ── convertBeans ─────────────────────────────────────────────────────────────

/**
 * Beans → diamonds.
 *
 * The 20:1 rate is deliberate friction, not a bug: without it, gift → convert →
 * re-gift is a closed loop that manufactures diamonds nobody paid for.
 *
 * Two problems with the version this replaces:
 *
 *   * It was read-then-batch, NOT a transaction. Two concurrent conversions both
 *     passed the balance check and both committed, driving beans negative.
 *   * The rate was `const BEANS_PER_DIAMOND = 20` in the APK, so changing it
 *     needed a Play release. It now comes from the CRM.
 *
 * Converted beans leave `beans`, which is also what payout eligibility reads —
 * so they correctly stop counting toward a withdrawal. That behaviour was
 * already right and is preserved.
 */
export const convertBeans = functions
  .region('asia-south1')
  .https.onCall(async (data: { beansAmount: number; idempotencyKey: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')
    // Auth-only guard. See functions/src/mobileSession.ts: refuses when the
    // caller presents a session id that is not the account's active one.
    await assertActiveSession(uid, data, 'convertBeans')

    const { beansAmount, idempotencyKey } = data ?? {}
    if (!Number.isInteger(beansAmount) || beansAmount <= 0) {
      throw new functions.https.HttpsError('invalid-argument', 'beansAmount must be a positive whole number.')
    }
    if (!idempotencyKey) {
      throw new functions.https.HttpsError('invalid-argument', 'idempotencyKey is required.')
    }

    const userRef   = db.collection('users').doc(uid)
    const configRef = db.collection('appConfig').doc('economy')
    const claimRef  = db.collection('walletIdempotency').doc(`${uid}_${idempotencyKey}`)

    return db.runTransaction(async (tx) => {
      const [claimSnap, userSnap, cfgSnap, weeksSnap] = await Promise.all([
        tx.get(claimRef), tx.get(userRef), tx.get(configRef),
        // Read before any write: the conversion has to be able to draw down
        // weeks that have not been released yet. See the payout note below.
        tx.get(userRef.collection('weeklyEarnings').where('released', '==', false)),
      ])
      if (claimSnap.exists) return { ...claimSnap.data(), replayed: true }
      if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')

      const cfg = (cfgSnap.data() ?? {}) as Record<string, any>
      /*
       * A WHOLE number of beans per diamond.
       *
       * The config field is a double, and this used to use it raw while the
       * Android client used `rate.toLong()`. At 20 they agreed and nothing
       * showed. Set it to 20.5 in the CRM and they part company completely:
       * the client checks its input against 20, the server checks
       * `beansAmount % 20.5`, and since `beansAmount` is required to be an
       * integer a few lines above, that modulus is non-zero for very nearly
       * every value a person could type. Conversion would refuse everyone, and
       * the reason would be invisible from either side.
       *
       * Truncating here makes the two ends agree by construction, and it
       * truncates rather than rounds because rounding 20.5 up to 21 would
       * quietly make every conversion worse for the host than the configured
       * rate promised.
       */
      const rawRate = Number(cfg.beanToDiamondRate)
      if (!Number.isFinite(rawRate) || rawRate < 1) {
        // Refuse rather than guess. A wrong conversion rate is not recoverable
        // once a user has spent the diamonds it produced.
        throw new functions.https.HttpsError('failed-precondition', 'Conversion is unavailable right now.')
      }
      const rate = Math.trunc(rawRate)

      if (beansAmount % rate !== 0) {
        throw new functions.https.HttpsError(
          'invalid-argument',
          `Convert in multiples of ${rate} beans.`,
        )
      }

      const beans = Number(userSnap.get('beans') ?? 0)
      if (beans < beansAmount) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Not enough beans. You have ${beans}.`,
        )
      }

      const diamondsGained = Math.floor(beansAmount / rate)
      const now = admin.firestore.FieldValue.serverTimestamp()

      // ── Converted beans must leave the payout pool ─────────────────────────
      //
      // The rule, as stated: beans a host converts to diamonds are not
      // considered for payout. Decrementing `beans` alone did not do that.
      // `beansAvailable` is the withdrawable figure and is tracked separately,
      // so a host could earn 10,000 beans, wait for Monday's release, convert
      // all 10,000 into diamonds, and still withdraw 10,000 — paid once in
      // diamonds and again in rupees for the same earning.
      //
      // Drawn down released-first, then from the oldest unreleased week. Taking
      // released beans first means a conversion spends money the host could
      // already have withdrawn, and leaves the pending weeks intact to release
      // on schedule — the reading least likely to surprise them.
      const available = Number(userSnap.get('beansAvailable') ?? 0)
      const fromAvailable = Math.min(beansAmount, available)
      let remainder = beansAmount - fromAvailable

      const userUpdate: Record<string, any> = {
        beans:    admin.firestore.FieldValue.increment(-beansAmount),
        diamonds: admin.firestore.FieldValue.increment(diamondsGained),
      }
      if (fromAvailable > 0) {
        userUpdate.beansAvailable = admin.firestore.FieldValue.increment(-fromAvailable)
      }
      tx.update(userRef, userUpdate)

      // Oldest week first — weekKey sorts lexicographically as `2026-W37`.
      const weeks = weeksSnap.docs
        .slice()
        .sort((a, b) => String(a.get('weekKey')).localeCompare(String(b.get('weekKey'))))
      for (const week of weeks) {
        if (remainder <= 0) break
        const inWeek = Number(week.get('beans') ?? 0)
        if (inWeek <= 0) continue
        const take = Math.min(remainder, inWeek)
        tx.update(week.ref, {
          beans:          admin.firestore.FieldValue.increment(-take),
          convertedBeans: admin.firestore.FieldValue.increment(take),
          updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
        })
        remainder -= take
      }

      tx.set(userRef.collection('beanTransactions').doc(), {
        type: 'debit',
        amount: beansAmount,
        balanceAfter: beans - beansAmount,
        reason: 'bean_conversion',
        reasonLabel: `Converted to ${diamondsGained} diamonds`,
        rate,
        context: 'conversion',
        timestamp: now,
      })
      tx.set(userRef.collection('diamondTransactions').doc(), {
        type: 'credit',
        amount: diamondsGained,
        balanceAfter: Number(userSnap.get('diamonds') ?? 0) + diamondsGained,
        reason: 'bean_conversion',
        reasonLabel: `Converted from ${beansAmount} beans`,
        rate,
        context: 'conversion',
        timestamp: now,
      })

      const result = { beansSpent: beansAmount, diamondsGained, rate }
      tx.set(claimRef, { ...result, uid, type: 'convertBeans', createdAt: now })
      return { ...result, replayed: false }
    })
  })

// ── claimDailyReward ─────────────────────────────────────────────────────────

/**
 * Daily sign-in reward.
 *
 * The client version credited diamonds itself and decided whether today had
 * already been claimed — so a modified app could claim the day-7 reward
 * repeatedly.
 *
 * The day key is IST, computed server-side. A device with its clock moved
 * forward claims nothing extra.
 */
export const claimDailyReward = functions
  .region('asia-south1')
  .https.onCall(async (_data, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const userRef  = db.collection('users').doc(uid)
    const today    = istDateKey()
    const claimRef = userRef.collection('dailyClaims').doc(today)
    const schedRef = db.collection('appConfig').doc('dailyRewards')

    return db.runTransaction(async (tx) => {
      const [userSnap, claimSnap, schedSnap] = await Promise.all([
        tx.get(userRef), tx.get(claimRef), tx.get(schedRef),
      ])
      if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')
      if (claimSnap.exists) {
        throw new functions.https.HttpsError('already-exists', 'Already claimed today.')
      }

      const FALLBACK_SCHEDULE = [
        { day: 1, diamonds: 50 },   { day: 2, diamonds: 75 },
        { day: 3, diamonds: 100, callCards: 1 },
        { day: 4, diamonds: 100 },  { day: 5, diamonds: 150, callCards: 1 },
        { day: 6, diamonds: 150 },  { day: 7, diamonds: 200, callCards: 2 },
      ]

      /*
       * Schedule from the CRM — but only if it is actually usable.
       *
       * `?? FALLBACK` alone was not enough, because the field can exist and
       * still be unusable. An EMPTY array is the case that matters: it passes
       * the nullish check, and then `prevStreak % 0` is NaN, `find` misses,
       * `sched[0]` is undefined, and `Number(reward.diamonds)` throws on a
       * property of undefined. Every claim, for every user, fails — from one
       * bad save in the CRM, with the only symptom an opaque INTERNAL error.
       *
       * So the guard is on length and shape, not on presence. A schedule that
       * is not an array of at least one row is treated as absent.
       */
      const raw = schedSnap.get('schedule')
      const sched = Array.isArray(raw) && raw.length > 0 && raw.every((r) => r && typeof r === 'object')
        ? (raw as any[])
        : FALLBACK_SCHEDULE

      // Streak continues only if yesterday was claimed; otherwise back to day 1.
      const yesterday = istDateKey(new Date(Date.now() - 24 * 60 * 60 * 1000))
      const lastClaim = userSnap.get('lastDailyClaimDate') as string | undefined
      const prevStreakRaw = Number(userSnap.get('dailyStreak') ?? 0)
      // A stored streak can be absent, negative or non-finite on an old account,
      // and `-3 % 7` is -3 in JavaScript, which would index nothing and pay the
      // day-1 fallback while claiming to be day -2.
      const prevStreak = Number.isFinite(prevStreakRaw) && prevStreakRaw > 0
        ? Math.trunc(prevStreakRaw)
        : 0
      const streak = lastClaim === yesterday ? (prevStreak % sched.length) + 1 : 1

      const reward = sched.find((r) => Number(r.day) === streak) ?? sched[0]
      // Never NaN into a balance increment: a NaN here would corrupt the
      // diamond field into something no later arithmetic could repair.
      const diamondsRaw = Number(reward.diamonds ?? 0)
      const diamonds = Number.isFinite(diamondsRaw) && diamondsRaw > 0 ? Math.trunc(diamondsRaw) : 0
      // `callCards` is what the CRM writes (lib/appConfig.ts). This read
      // `freeCallMinutes` — a name from the app's own hardcoded table — so
      // once the CRM had saved the schedule, every claim granted zero cards
      // while the CRM and the app both displayed "x1 / x2". Accept both, CRM
      // name first.
      const videoCardsRaw = Number(reward.callCards ?? reward.freeCallMinutes ?? 0)
      const videoCards = Number.isFinite(videoCardsRaw) && videoCardsRaw > 0
        ? Math.trunc(videoCardsRaw)
        : 0
      const now = admin.firestore.FieldValue.serverTimestamp()

      const updates: Record<string, any> = {
        diamonds: admin.firestore.FieldValue.increment(diamonds),
        dailyStreak: streak,
        lastDailyClaimDate: today,
      }
      if (videoCards > 0) {
        updates.videoCards = admin.firestore.FieldValue.increment(videoCards)
      }
      tx.update(userRef, updates)

      tx.set(claimRef, { day: streak, diamonds, videoCards, claimedAt: now })
      tx.set(userRef.collection('diamondTransactions').doc(), {
        type: 'credit',
        amount: diamonds,
        balanceAfter: Number(userSnap.get('diamonds') ?? 0) + diamonds,
        reason: 'daily_reward',
        reasonLabel: `Daily reward — day ${streak}`,
        context: 'reward',
        timestamp: now,
      })

      return { day: streak, diamonds, videoCards }
    })
  })

// ── purchaseBagItem ──────────────────────────────────────────────────────────

/**
 * Buys a cosmetic.
 *
 * Two things the client version could not do correctly:
 *
 *   * The price came from the client's copy of the item.
 *   * Nothing enforced expiry. `ownedItems` has no time concept at all, so a
 *     timed item was owned forever.
 *
 * Buying while an item is still active EXTENDS it — `max(now, existing) +
 * duration`. That has to happen here rather than on the client, or the renewal
 * date shown on the cosmetic screen is a promise nothing keeps.
 */
export const purchaseBagItem = functions
  .region('asia-south1')
  .https.onCall(async (data: { itemId: string; durationDays?: number; idempotencyKey: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')
    // Auth-only guard. See functions/src/mobileSession.ts: refuses when the
    // caller presents a session id that is not the account's active one.
    await assertActiveSession(uid, data, 'purchaseBagItem')

    const { itemId, durationDays, idempotencyKey } = data ?? {}
    if (!itemId) throw new functions.https.HttpsError('invalid-argument', 'itemId is required.')
    if (!idempotencyKey) throw new functions.https.HttpsError('invalid-argument', 'idempotencyKey is required.')

    const userRef  = db.collection('users').doc(uid)
    const itemRef  = db.collection('bagItems').doc(itemId)
    const ownedRef = userRef.collection('ownedItems').doc(itemId)
    const claimRef = db.collection('walletIdempotency').doc(`${uid}_${idempotencyKey}`)

    return db.runTransaction(async (tx) => {
      const [claimSnap, userSnap, itemSnap, ownedSnap] = await Promise.all([
        tx.get(claimRef), tx.get(userRef), tx.get(itemRef), tx.get(ownedRef),
      ])
      if (claimSnap.exists) return { ...claimSnap.data(), replayed: true }
      if (!userSnap.exists) throw new functions.https.HttpsError('not-found', 'Account not found.')
      if (!itemSnap.exists) throw new functions.https.HttpsError('not-found', 'That item no longer exists.')

      const item = itemSnap.data() as Record<string, any>

      // PRICE FROM THE SERVER. If the CRM offers a duration matrix, the chosen
      // row must be one it actually lists — not a duration the client invented.
      const durations = (item.durations as any[] | undefined) ?? null
      let price = Number(item.price ?? 0)
      let days = 0
      if (durations && durations.length > 0) {
        const chosen = durationDays
          ? durations.find((d) => Number(d.days) === Number(durationDays))
          : durations[0]
        if (!chosen) {
          throw new functions.https.HttpsError('invalid-argument', 'That duration is not available.')
        }
        price = Number(chosen.priceGems ?? chosen.price ?? 0)
        days = Number(chosen.days ?? 0)
      }

      // ── Eligibility, enforced here and not only in the bag screen ─────────
      //
      // MyBagViewModel already filters on isActive, targetUserId,
      // targetGender and targetRole — but that is a display filter. A request
      // to this function can name any itemId, so an item switched off in the
      // CRM, or reserved for one account, stays buyable by anyone until the
      // server checks it too. Same precedence as the client, deliberately:
      // targetUserId first, then gender, then role.
      if (item.isActive === false) {
        throw new functions.https.HttpsError('failed-precondition', 'That item is not available.')
      }
      // `source: 'level'` items are earned by levelling, not bought. They carry
      // a price for display, which is exactly why this has to be refused.
      if (item.source === 'level') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This item unlocks with your level — it cannot be bought.',
        )
      }

      const userGender = String(userSnap.get('gender') ?? '')
      const userIsHost = userSnap.get('isHost') === true
      const targetUserId = String(item.targetUserId ?? '')
      const targetGender = String(item.targetGender ?? 'all')
      const targetRole   = String(item.targetRole ?? 'all')

      const eligible =
        targetUserId !== ''                ? targetUserId === uid
        : targetGender !== 'all' && (userGender === 'male' || userGender === 'female')
                                           ? targetGender === userGender
        : targetRole === 'user'            ? !userIsHost
        : targetRole === 'host'            ? userIsHost
        : true
      if (!eligible) {
        throw new functions.https.HttpsError('permission-denied', 'This item is not available to your account.')
      }

      // Level gates, both of them.
      const userLevel = Number(userSnap.get('level') ?? 0)
      const hostLevel = Number(userSnap.get('hostLevel') ?? 0)
      if (userLevel < Number(item.unlockLevel ?? 0)) {
        throw new functions.https.HttpsError('failed-precondition', `Reach level ${item.unlockLevel} first.`)
      }
      if (hostLevel < Number(item.minHostLevel ?? 0)) {
        throw new functions.https.HttpsError('failed-precondition', `Reach host level ${item.minHostLevel} first.`)
      }

      const diamonds = Number(userSnap.get('diamonds') ?? 0)
      if (price > 0 && diamonds < price) {
        throw new functions.https.HttpsError(
          'failed-precondition',
          `Not enough diamonds. This costs ${price}, you have ${diamonds}.`,
        )
      }

      // EXTEND from whichever is later — now, or the existing expiry. Buying a
      // renewal early must not throw away the days already paid for.
      const nowMs = Date.now()
      const existing = ownedSnap.exists
        ? (ownedSnap.get('expiresAt') as admin.firestore.Timestamp | null)
        : null
      const base = existing && existing.toMillis() > nowMs ? existing.toMillis() : nowMs
      const expiresAt = days > 0
        ? admin.firestore.Timestamp.fromMillis(base + days * 24 * 60 * 60 * 1000)
        : null    // null = permanent

      const now = admin.firestore.FieldValue.serverTimestamp()

      if (price > 0) {
        tx.update(userRef, { diamonds: admin.firestore.FieldValue.increment(-price) })
        tx.set(userRef.collection('diamondTransactions').doc(), {
          type: 'debit',
          amount: price,
          balanceAfter: diamonds - price,
          reason: 'bag_purchase',
          reasonLabel: `${item.name ?? itemId}${days > 0 ? ` — ${days} days` : ''}`,
          itemId,
          durationDays: days,
          context: 'shop',
          timestamp: now,
        })
      }

      tx.set(ownedRef, {
        itemId,
        category: item.category ?? '',
        acquiredAt: ownedSnap.exists ? ownedSnap.get('acquiredAt') ?? now : now,
        expiresAt,
        durationDaysTotal: days,
        // Set even for permanent items (expiresAt null never trips the range
        // filter), so every ownedItems doc has a uniform shape.
        expired: false,
        source: 'purchase',
        renewCount: admin.firestore.FieldValue.increment(ownedSnap.exists ? 1 : 0),
      }, { merge: true })

      const result = {
        itemId,
        pricePaid: price,
        durationDays: days,
        expiresAt: expiresAt ? expiresAt.toMillis() : null,
        extended: !!(existing && existing.toMillis() > nowMs),
      }
      tx.set(claimRef, { ...result, uid, type: 'purchaseBagItem', createdAt: now })
      return { ...result, replayed: false }
    })
  })

// ── equipBagItem ─────────────────────────────────────────────────────────────

/**
 * The category-to-pointer map, in one place.
 *
 * `equipBagItem` writes these and `expireCosmetics` clears them, and the two
 * disagreeing would mean an item that could be equipped and never expired, or
 * expired and never cleared. Same constant for both.
 */
const EQUIP_POINTERS: Record<string, string> = {
  frame:        'equippedFrame',
  chat_bubble:  'equippedChatBubble',
  profile_card: 'equippedProfileCard',
  id_frame:     'equippedIdFrame',
  entrance:     'equippedEntrance',
}

/**
 * Wears a cosmetic, or takes it off.
 *
 * ── WHY THIS IS NOT A CLIENT WRITE ───────────────────────────────────────────
 *
 * It used to be: `BagRepository.equipItem` did
 * `users/{uid}.update(equippedFrame, itemId)` directly, and the rules did not
 * list those pointers as protected. So the entire timed-cosmetic economy was
 * voluntary. Anyone could write any item id to any pointer and wear a cosmetic
 * they had never bought; and when `expireCosmetics` cleared an expired pointer
 * on the hour, the client could write it straight back — an unpaid frame
 * blinking off and on forever.
 *
 * The check that closes it cannot be expressed as a security rule. It needs a
 * lookup in a sibling subcollection (`ownedItems/{itemId}`) plus a comparison
 * against the current time, and rules can do neither. So the pointers became
 * server-owned and this is their writer.
 *
 * ── AND WHY EXPIRY IS CHECKED ON THE TIMESTAMP, NOT THE FLAG ─────────────────
 *
 * `expired` is set by an hourly sweep, so for up to an hour after a term ends
 * the flag still says false. Trusting it would sell a free extra hour on every
 * cosmetic on the platform. `expiresAt` is the truth; the flag is a convenience
 * for the sweep's own index.
 *
 * Passing an empty `itemId` unequips, which is how the "none" option in the bag
 * is expressed — a separate callable for that would be two functions that must
 * agree about the same pointer table.
 */
export const equipBagItem = functions
  .region('asia-south1')
  .https.onCall(async (data: { itemId: string; category: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Not signed in.')

    const category = String(data?.category ?? '').trim()
    const itemId   = String(data?.itemId ?? '').trim()

    const pointer = EQUIP_POINTERS[category]
    if (!pointer) {
      throw new functions.https.HttpsError('invalid-argument', `Unknown category "${category}".`)
    }

    const userRef = db.collection('users').doc(uid)

    // Taking it off needs no ownership check — nobody has ever been harmed by
    // being allowed to stop wearing something.
    if (itemId === '') {
      await userRef.update({ [pointer]: '' })
      return { equipped: '', category }
    }

    const ownedRef = userRef.collection('ownedItems').doc(itemId)
    const itemRef  = db.collection('bagItems').doc(itemId)

    const [ownedSnap, itemSnap] = await Promise.all([ownedRef.get(), itemRef.get()])

    if (!ownedSnap.exists) {
      throw new functions.https.HttpsError('permission-denied', 'You do not own that item.')
    }

    /*
     * The item's real category, not the one the request claimed.
     *
     * Otherwise a cheap frame could be equipped into the entrance slot by
     * simply saying so — and entrances are the expensive tier.
     */
    const realCategory = String(itemSnap.get('category') ?? ownedSnap.get('category') ?? '')
    if (realCategory !== '' && realCategory !== category) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'That item cannot be worn in that slot.',
      )
    }

    const expiresAt = ownedSnap.get('expiresAt') as admin.firestore.Timestamp | null | undefined
    if (expiresAt && expiresAt.toMillis() <= Date.now()) {
      throw new functions.https.HttpsError(
        'failed-precondition',
        'That item has expired. Renew it to wear it again.',
      )
    }

    await userRef.update({ [pointer]: itemId })
    return { equipped: itemId, category }
  })

// ── expireCosmetics ──────────────────────────────────────────────────────────

/**
 * Removes expired cosmetics and, crucially, unequips them.
 *
 * Clearing the inventory row alone is not enough: `users/{uid}.equippedFrame`
 * and friends are separate pointers, and an expired frame whose pointer survives
 * keeps rendering. The user sees an item they no longer own and no longer pay
 * for, which is the version of this bug nobody notices until a paying customer
 * asks why they bothered renewing.
 */
export const expireCosmetics = functions
  .region('asia-south1')
  .pubsub.schedule('0 * * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now()
    // `expired == false`, not `!= true`. Firestore's `!=` only matches
    // documents where the field EXISTS, and a freshly purchased item has no
    // `expired` field — so the original query would have matched nothing,
    // forever, while appearing to run fine every hour. purchaseBagItem now
    // writes `expired: false` so every row is visible to this sweep.
    //
    // It is also equality + one range, which is an ordinary composite index.
    // The `!=` form was a second inequality on a different field.
    const expired = await db.collectionGroup('ownedItems')
      .where('expired', '==', false)
      .where('expiresAt', '<', now)
      .limit(500)
      .get()

    // Shared with equipBagItem, deliberately: the writer and the clearer of
    // these pointers must never disagree about which field belongs to which
    // category.
    const POINTERS = EQUIP_POINTERS

    let count = 0
    for (const doc of expired.docs) {
      const userRef = doc.ref.parent.parent
      if (!userRef) continue
      const itemId = doc.get('itemId') ?? doc.id
      const pointer = POINTERS[String(doc.get('category') ?? '')]
      try {
        const batch = db.batch()
        batch.update(doc.ref, { expired: true, expiredAt: now })
        if (pointer) {
          const snap = await userRef.get()
          if (snap.get(pointer) === itemId) batch.update(userRef, { [pointer]: '' })
        }
        await batch.commit()
        count++
      } catch (err) {
        functions.logger.error(`expireCosmetics: ${doc.ref.path}`, err)
      }
    }
    if (count > 0) functions.logger.info(`expireCosmetics retired ${count} item(s)`)
    return null
  })

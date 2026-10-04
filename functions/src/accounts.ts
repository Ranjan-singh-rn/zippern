import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import * as admin from 'firebase-admin'

const db = admin.firestore()
const REGION = 'asia-south1' as const

/**
 * Deleting an account — as a thirty-day pause, not a cliff.
 *
 * ── WHAT "DELETE MY ACCOUNT" USED TO DO ──────────────────────────────────────
 *
 * The dialog said "This is permanent. Your profile, chats and history are
 * removed." What actually happened: `isDeleted: true` was written to the user
 * document and the app navigated to Login — unconditionally, discarding the
 * result, so a failure looked identical to a success. Nothing purged anything,
 * ever; no scheduled function referenced the flag. The only consumer was one
 * line in the discovery feed, which hid the person from search.
 *
 * So the account persisted indefinitely, the user believed it was gone, and if
 * they signed back in they were permanently invisible with no way to undo it —
 * a flag nothing cleared.
 *
 * ── WHAT IT DOES NOW ─────────────────────────────────────────────────────────
 *
 * Deletion is a request with a deadline, the way every consumer product does
 * it, and for the reason they all do it: people delete accounts in anger, at
 * two in the morning, by mistyping, and by handing the phone to a child. The
 * thirty days exist so that changing your mind costs a tap instead of a support
 * ticket.
 *
 *   request  →  `isDeleted: true`, `deletionRequestedAt`, `deletionDueAt`
 *               The account is hidden everywhere and stops ringing, but nothing
 *               is destroyed.
 *   within 30 days, they sign in  →  `recoverAccount`, everything restored
 *                                    exactly as it was.
 *   or they choose to finish now  →  `purgeMyAccountNow`.
 *   or the thirty days elapse     →  `purgeDeletedAccounts` finishes it.
 *
 * ── WHAT A PURGE RELEASES, AND WHAT IT KEEPS FOR EVER ────────────────────────
 *
 * This used to DELETE the user document and eleven subcollections, including
 * `diamondTransactions` and `beanTransactions` — every coin purchase and every
 * bean movement the person had ever made. That was wrong, and it was wrong in a
 * way nobody would notice until they needed it: the CRM's history of a customer
 * quietly evaporated thirty days after they tapped a button in the app, and a
 * chargeback or a dispute six months later had nothing to answer from.
 *
 * The rule now separates two things that were being conflated:
 *
 *   THE IDENTITY is released. The phone number and email come off the Firebase
 *   account and off the document, the auth login is deleted, the profile media
 *   is removed, and the person disappears from every feed. Nobody can sign in
 *   as them, and — the point of releasing rather than deleting — that phone
 *   number becomes available to be bound to a different account.
 *
 *   THE HISTORY stays, for the life of the CRM. The user document is not
 *   deleted; it becomes the historical record, marked
 *   `accountState: 'permanently_deactivated'`. Its transactions, earnings,
 *   warnings and gift history stay exactly where they are, still keyed by uid,
 *   still joinable to the ledger and the audit log.
 *
 * So a rebound phone number does NOT carry the old account's history with it.
 * Account A keeps its own record; account B gets the number and starts clean.
 * That is the audit trail the business runs on.
 *
 * What still goes: the things that are the person's own content and identity
 * rather than a business record — the public profile, the face-verification
 * capture, the push tokens, the uploaded photos.
 */

/**
 * How long a deleted account can still be recovered.
 *
 * Configurable rather than hardcoded — spec 38. Read from the environment so it
 * can be changed without a code release.
 *
 * SIXTY days, raised from thirty. The app's own deletion copy still says thirty
 * in places; that string is Android's and is corrected in the Android phase of
 * this workstream. The number that decides whether an account is still
 * recoverable is this one, and it is the one `purgeDeletedAccounts` reads, so
 * raising it here lengthens the window immediately and for accounts already
 * inside it — their `deletionDueAt` was stamped at request time and is not
 * recomputed, so an account deleted before this change keeps its original
 * thirty-day deadline. That is deliberate: moving a deadline somebody was told
 * would be met is a worse surprise than an inconsistent one.
 */
const GRACE_DAYS = Number(process.env.ACCOUNT_RECOVERY_DAYS ?? 60) || 60

/*
 * ── THE ACCOUNT STATE MODEL ──────────────────────────────────────────────────
 *
 * One field, `users/{uid}.accountState`, with five values. It exists because
 * `isDeleted: true` could not tell apart the two situations that matter most:
 * an account somebody can still get back, and one whose identity has been
 * released and given away. Those need different answers at the login screen and
 * they need different answers when a phone number is being bound.
 *
 *   active                    — the ordinary case.
 *   suspended                 — temporarily restricted. The DEVICE stays
 *                               clean, so the person may sign in with a
 *                               different account on the same phone. Reversed
 *                               by Resume, never by Unban.
 *   banned                    — restricted, and every device the account has
 *                               been seen on is barred too. Reversed by Unban,
 *                               never by Resume.
 *   recovery_pending          — deletion requested, inside the grace window.
 *                               Hidden everywhere, recoverable in one tap, and
 *                               its phone number is still ITS OWN.
 *   permanently_deactivated   — the grace window elapsed, or the person chose
 *                               to finish now. The login is gone and the
 *                               identity is released, but the history remains
 *                               for the life of the CRM.
 *
 * `isDeleted` is still written alongside, because feeds, rules and the CRM all
 * read it and a state machine nobody consults is not a state machine. It means
 * "not an active account" — either of the last two.
 */
export const STATE_ACTIVE = 'active'
export const STATE_SUSPENDED = 'suspended'
export const STATE_BANNED = 'banned'
export const STATE_RECOVERY_PENDING = 'recovery_pending'
export const STATE_PERMANENTLY_DEACTIVATED = 'permanently_deactivated'

/**
 * Subcollections removed on a purge — the person's own content and the things
 * that only mean anything to a live account.
 *
 * `fcmTokens` because a deleted account must stop ringing. `followers` and
 * `following` because a social graph edge to an account nobody can reach is
 * noise in everybody else's lists. `ownedItems` because a cosmetic cannot be
 * worn by a login that no longer exists.
 */
const PURGED_SUBCOLLECTIONS = [
  'fcmTokens', 'followers', 'following', 'ownedItems',
]

/**
 * Subcollections that survive for the life of the CRM. NEVER add a delete for
 * one of these.
 *
 * Every entry is a business record rather than the person's data: what they
 * bought, what they earned, what they were warned for, what they were gifted.
 * A user tapping "delete my account" is asking to leave, not asking the
 * business to forget that money changed hands — and the reports, the
 * reconciliation and any future dispute are all answered from exactly these
 * rows. See the header note.
 */
export const RETAINED_SUBCOLLECTIONS = [
  'diamondTransactions', 'beanTransactions', 'dailyStats',
  'weeklyEarnings', 'warnings', 'giftShowcase', 'blocked',
]

async function deleteQuery(
  query: FirebaseFirestore.Query,
  batchSize = 300,
): Promise<number> {
  let removed = 0
  for (;;) {
    const page = await query.limit(batchSize).get()
    if (page.empty) return removed
    const batch = db.batch()
    page.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
    removed += page.size
    if (page.size < batchSize) return removed
  }
}

/**
 * Destroy one account. Used by both the scheduled sweep and the immediate path.
 *
 * Order matters. The auth login goes LAST: if it went first and the Firestore
 * work then failed, the result would be a signed-out person with an orphaned
 * document and no way to reach it — which is precisely the state that traps
 * somebody on profile setup for ever.
 */
async function purgeAccount(uid: string): Promise<{ uid: string; removed: number }> {
  let removed = 0

  for (const sub of PURGED_SUBCOLLECTIONS) {
    removed += await deleteQuery(db.collection('users').doc(uid).collection(sub))
  }
  // RETAINED_SUBCOLLECTIONS is deliberately not iterated here. It is named
  // above so that the absence is visibly a decision rather than an omission.

  await db.collection('publicProfiles').doc(uid).delete().catch(() => undefined)
  await db.collection('hostVerification').doc(uid).delete().catch(() => undefined)
  removed += 2

  /*
   * The user document BECOMES the historical record rather than being deleted.
   *
   * Everything that identifies a living person goes — name, photo, phone,
   * email, the session, the device, the presence flags — so the account cannot
   * be signed into, cannot be found, and cannot be contacted. `phoneKey` and
   * `email` are cleared specifically so the identity is RELEASED: the number is
   * then free to be verified and bound to somebody else's account, which is the
   * whole of spec case C.
   *
   * What stays is the skeleton the history hangs on: the uid, when the account
   * existed, what role it held, and which agency it belonged to. Without those
   * the retained transactions are rows about nobody.
   */
  await db.collection('users').doc(uid).set(
    {
      accountState: STATE_PERMANENTLY_DEACTIVATED,
      isDeleted: true,
      purgedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Identity released.
      name: '',
      photoUrl: '',
      bio: '',
      phoneNumber: '',
      phoneKey: '',
      email: '',
      sessionToken: '',
      deviceId: '',
      fcmToken: '',
      // Gone from every surface.
      isListed: false,
      isOnline: false,
      isLive: false,
      isInCall: false,
      isInParty: false,
    },
    { merge: true },
  ).catch(() => undefined)
  removed += 1

  // Uploaded media. Best-effort: a storage failure must not leave the account
  // half-deleted, and an orphaned file is a far smaller problem than a user
  // document that survived the purge.
  try {
    await admin.storage().bucket().deleteFiles({ prefix: `profileMedia/${uid}/` })
  } catch (err) {
    logger.warn(`purgeAccount: storage for ${uid} could not be cleared`, err)
  }

  // Last, for the reason above.
  try {
    await admin.auth().deleteUser(uid)
  } catch (err) {
    // Already gone is success, not failure.
    logger.info(`purgeAccount: auth account ${uid} was already absent`, err)
  }

  return { uid, removed }
}

// ── Request deletion ─────────────────────────────────────────────────────────

/**
 * Ask for the account to be deleted. Schedules it; destroys nothing.
 *
 * ── WHY THIS MOVED OFF THE CLIENT ────────────────────────────────────────────
 *
 * It used to be a direct Firestore write from the app. That stopped being
 * possible the moment `accountState` became a protected field — and it needed
 * to become protected, because a client that can write it can also write
 * `accountState: 'active'`, which would let somebody undo their own deletion
 * after the binding rules had already released their phone number to another
 * account. Two accounts, one number, and no way to tell which one owns it.
 *
 * The deadline is set HERE for the same reason `tickCall` clocks a call here:
 * the old code computed `now + 30 days` from the device, and a phone with its
 * clock set forward could schedule its own purge for yesterday.
 */
export const requestAccountDeletion = onCall(
  { region: REGION },
  async (req: CallableRequest<Record<string, never>>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const ref = db.collection('users').doc(uid)
    const snap = await ref.get()
    if (!snap.exists) throw new HttpsError('not-found', 'No account to delete.')

    if (snap.get('accountState') === STATE_PERMANENTLY_DEACTIVATED) {
      return { requested: false, alreadyDeleted: true, dueAtMs: 0 }
    }
    if (snap.get('isDeleted') === true) {
      // Idempotent. Asking twice does not shorten the window.
      const existing = snap.get('deletionDueAt') as admin.firestore.Timestamp | null
      return { requested: true, alreadyDeleted: false, dueAtMs: existing?.toMillis() ?? 0 }
    }

    const now = admin.firestore.Timestamp.now()
    const dueAt = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + GRACE_DAYS * 24 * 60 * 60 * 1000,
    )

    await ref.set(
      {
        accountState: STATE_RECOVERY_PENDING,
        isDeleted: true,
        deletionRequestedAt: now,
        deletionDueAt: dueAt,
        isOnline: false,
        isListed: false,
        // The session goes with it — a deleted account must not stay signed in
        // on a device somebody handed back.
        activeMobileSession: admin.firestore.FieldValue.delete(),
        sessionToken: '',
      },
      { merge: true },
    )

    logger.info('account deletion requested', { uid, dueAt: dueAt.toMillis() })
    return { requested: true, alreadyDeleted: false, dueAtMs: dueAt.toMillis() }
  },
)

// ── Recover ───────────────────────────────────────────────────────────────────

/**
 * Change your mind, within the thirty days.
 *
 * A callable rather than a client write, for the same reason every other state
 * change about an account is: it is recorded, and the rules do not have to be
 * widened to let a user edit their own deletion status.
 */
export const recoverAccount = onCall(
  { region: REGION },
  async (req: CallableRequest<Record<string, never>>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const ref = db.collection('users').doc(uid)
    const snap = await ref.get()
    if (!snap.exists) {
      throw new HttpsError(
        'not-found',
        'This account has already been deleted and cannot be recovered.',
      )
    }
    if (snap.get('isDeleted') !== true) {
      // Idempotent: nothing to undo is not an error.
      return { recovered: false, alreadyActive: true }
    }

    /*
     * Past the grace window there is nothing to recover TO.
     *
     * The identity has been released — the auth login deleted, the phone number
     * free for somebody else to bind — so "restoring" the account would give
     * back a document with no way to sign into it, and might hand back a phone
     * number that now belongs to a different person. The history stays; the
     * account does not come back.
     */
    if (snap.get('accountState') === STATE_PERMANENTLY_DEACTIVATED) {
      throw new HttpsError(
        'failed-precondition',
        'The recovery period for this account has passed. Its history is kept, ' +
          'but the account cannot be restored.',
      )
    }

    await ref.update({
      accountState: STATE_ACTIVE,
      isDeleted: admin.firestore.FieldValue.delete(),
      deletionRequestedAt: admin.firestore.FieldValue.delete(),
      deletionDueAt: admin.firestore.FieldValue.delete(),
      recoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    logger.info('account recovered', { uid })
    return { recovered: true, alreadyActive: false }
  },
)

// ── Finish it now ─────────────────────────────────────────────────────────────

/**
 * Skip the thirty days.
 *
 * Offered beside Recover, because somebody who has come back specifically to
 * confirm the deletion should not have to wait a month for it, and because an
 * account they intend to replace has to be gone before the same phone number
 * can sign up again.
 */
export const purgeMyAccountNow = onCall(
  { region: REGION },
  async (req: CallableRequest<Record<string, never>>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return { purged: true, alreadyGone: true }

    // Only from the deleted state. Otherwise this is a one-call account
    // destructor reachable by anything holding a token.
    if (snap.get('isDeleted') !== true) {
      throw new HttpsError(
        'failed-precondition',
        'Request deletion from Settings first.',
      )
    }

    const result = await purgeAccount(uid)
    logger.info('account purged on request', result)
    return { purged: true, alreadyGone: false }
  },
)

// ── The thirty-day sweep ──────────────────────────────────────────────────────

/**
 * Finish deletions whose grace period has run out.
 *
 * Daily at 03:30 IST — after the nightly jobs, before anybody is awake to be
 * confused by an account disappearing mid-session.
 *
 * Bounded at fifty an run. This is not a queue that spikes, and a purge does a
 * dozen writes plus a storage listing per account; a sweep that tried to clear
 * a backlog in one pass would be the thing that took the database down.
 */
export const purgeDeletedAccounts = functions
  .region(REGION)
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .pubsub.schedule('30 3 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now()
    const due = await db.collection('users')
      .where('isDeleted', '==', true)
      .where('deletionDueAt', '<=', now)
      .limit(50)
      .get()

    let purged = 0
    for (const doc of due.docs) {
      try {
        await purgeAccount(doc.id)
        purged++
      } catch (err) {
        // One account that will not delete must not stop the other forty-nine.
        logger.error(`purgeDeletedAccounts: ${doc.id} failed`, err)
      }
    }

    if (purged > 0) logger.info(`purgeDeletedAccounts purged ${purged} account(s)`)
    return null
  })

export { GRACE_DAYS }

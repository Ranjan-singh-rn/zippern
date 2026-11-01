import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https'
import * as functions from 'firebase-functions/v1'
import * as logger from 'firebase-functions/logger'
import * as admin from 'firebase-admin'
import { SESSION_DISPLACED, presentedSessionId } from './mobileSession'
import { rosterRemovalFields, rosterRowIsCurrent } from './roster'

const db = admin.firestore()
const REGION = 'asia-south1' as const

/**
 * Deleting an account — as a sixty-day pause (`GRACE_DAYS`), not a cliff.
 *
 * ── SPEC §7, VERIFIED 2026-11-01 (functions hygiene batch) ───────────────────
 *
 *   request    `requestAccountDeletion` → `accountState: 'recovery_pending'`,
 *              `deletionDueAt = now + GRACE_DAYS` (60), stamped by the SERVER's
 *              clock. A REPEATED request never moves the deadline: the
 *              `isDeleted === true` branch answers with the existing due date
 *              and writes nothing (test: accountDeletionSpec7.test.js).
 *   recover    `recoverAccount` before the due date restores the account
 *              exactly as it was. AT or after the due date — whether or not
 *              the sweep has run yet — it refuses `RECOVERY_EXPIRED` (C8/B27)
 *              and the scheduled purge finishes the deletion.
 *   purge      `purgeDeletedAccounts` (03:30 IST) / `purgeMyAccountNow`.
 *              Idempotent: a completed record leaves the queue, a retry
 *              repeats no destructive step (DEACT-001, `finishPurge`).
 *   staff /    A login with protected CRM access refuses `CRM_ACCESS_HELD`
 *   partner    (STAFF-005); a Host with unsettled responsibilities refuses
 *              `PARTNER_RESPONSIBILITIES`; the sweep HOLDS either rather than
 *              purging around it. Governance and audit records are never
 *              destroyed by a self-deletion — see the table below.
 *   blockers   F-21: the open-withdrawal check FAILS CLOSED. A read error is
 *              `unavailable` (`DELETION_CHECK_UNAVAILABLE`), nothing is written,
 *              and the sweep retries that account the next night.
 *
 * ── WHAT A PURGE DELETES, WHAT IT ANONYMISES, WHAT IT KEEPS ──────────────────
 *
 *   DELETED (gone for good)
 *     users/{uid}/{fcmTokens,followers,following,ownedItems}   PURGED_SUBCOLLECTIONS
 *     publicProfiles/{uid}, hostVerification/{uid} (Firestore)
 *     publicSellers/{sellerId} owned by the uid
 *     Cloud Storage  profileMedia/{uid}/*  and  hostVerification/{uid}/*
 *                    (F-10 — the face-verification capture and its attempts.
 *                    OWNER_DECISION_PENDING, audit Q8: delete at purge is the
 *                    DEFAULT; if the owner decides biometric captures must be
 *                    retained for dispute defence, remove that prefix from
 *                    `purgedStoragePrefixes` and set a retention period there.)
 *     The Firebase Auth login (last, see `purgeAccount`).
 *
 *   ANONYMISED (the document stays, the person is removed from it)
 *     users/{uid}: name, photoUrl, bio, phoneNumber, phoneKey, email,
 *     sessionToken, deviceId, fcmToken → '' ; every presence/listing flag →
 *     false ; every active role flag → false ; `accountState:
 *     'permanently_deactivated'`, `isDeleted: true`, `purgedAt`.
 *     crmUsers/{uid} (a released partner login): `isActive: false`, `purgedAt`.
 *     agencies/{agencyId}/agencyHosts/{uid}: marked inactive ('purged'), kept.
 *
 *   RETAINED (financial and audit retention — never deleted by a purge)
 *     users/{uid}/{diamondTransactions, beanTransactions, dailyStats,
 *     weeklyEarnings, warnings, giftShowcase, blocked}   RETAINED_SUBCOLLECTIONS
 *     The skeleton on users/{uid}: uid, agencyId, timestamps, balances.
 *     Every top-level ledger row that names the uid (giftTransactions,
 *     giftEvents, platformRevenue, withdrawalRequests, weeklyPayoutReports/…,
 *     appeals, authEvents, reports) — a purge touches none of them.
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
 *   within GRACE_DAYS, they sign in →  `recoverAccount`, everything restored
 *                                    exactly as it was.
 *   or they choose to finish now  →  `purgeMyAccountNow`.
 *   or the grace days elapse      →  `purgeDeletedAccounts` finishes it.
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

/*
 * ── WHO MAY MOVE AN ACCOUNT THROUGH DELETION (B1, Phase 1A.2) ─────────────────
 *
 * N3. These three callables used to check only that the caller was signed in.
 * A device that had been displaced by a newer sign-in — or any token issued
 * before the account's credential cut-off — could request a deletion, and then
 * finish it at once: `requestAccountDeletion` revokes refresh tokens, but an
 * ID token already issued stays valid for up to an hour and callables do not
 * check revocation. Now every one of them refuses a sign-in whose `auth_time`
 * predates `credentialsValidAfter` — the same test the rules' `sessionCurrent()`
 * applies — and refuses a missing, invalid or future `auth_time` outright.
 *
 *   requestAccountDeletion  runs inside the app, on the account's active
 *                           mobile session, so that session is REQUIRED: the
 *                           presented `sessionId` must equal the recorded one.
 *                           A missing id is not proof of anything.
 *   recoverAccount,         run after a FRESH sign-in. The request deleted the
 *   purgeMyAccountNow       session and moved the cut-off past its own time,
 *                           and the app's sign-in stops at the recovery screen
 *                           before starting a new session — so there is
 *                           usually no session to present. The cut-off is what
 *                           proves freshness here. If a session IS on record,
 *                           it must be presented and match. A left-over local
 *                           id with nothing on record is ignored: it proves
 *                           nothing either way, and refusing it would strand a
 *                           second device the person signed back in on.
 *
 * "Delete now" additionally needs a sign-in no older than ten minutes, by the
 * server's clock (DELETE_NOW_MAX_SIGN_IN_AGE_SECONDS). Nothing else does.
 *
 * STAFF-005. Staff and partners sign in to the CRM with the same Firebase
 * identity the app uses. Deleting the app account deleted that identity — an
 * Owner tapping "Delete account" in Settings lost the CRM. So a login with
 * protected CRM access cannot request or finish a deletion, and the nightly
 * sweep holds such an account rather than deleting it. "Protected" is read
 * from the server's own `crmUsers/{uid}` record — written by the backend, and
 * the rules let no client change its role, roles, roleStatus, status or
 * isActive — never from anything the caller sends:
 *
 *   staff     any non-partner CRM role on a login that is not switched off;
 *   partner   an agency or coin-seller capability whose status is approved,
 *             pending or suspended — or any status this build does not know.
 *             A capability that is only rejected or revoked protects nothing.
 *
 * Error codes, in `HttpsError.details.code`:
 *
 *   SESSION_DISPLACED        the sign-in predates the cut-off; its auth_time is
 *                            missing, invalid or in the future; or the presented
 *                            session id is not the active one.
 *   SESSION_REQUIRED         the active mobile session must be presented and
 *                            was not, or the account has none on record.
 *   RECENT_SIGN_IN_REQUIRED  "Delete now" needs a sign-in within ten minutes; a
 *                            missing, invalid or future auth_time fails it too.
 *   CRM_ACCESS_HELD          the login is a protected CRM identity
 *                            (`details.access` is 'staff' or 'partner').
 */
export const SESSION_REQUIRED = 'SESSION_REQUIRED'
export const RECENT_SIGN_IN_REQUIRED = 'RECENT_SIGN_IN_REQUIRED'
export const CRM_ACCESS_HELD = 'CRM_ACCESS_HELD'

/** "Delete now" needs a sign-in no older than this. Approved: ten minutes. */
export const DELETE_NOW_MAX_SIGN_IN_AGE_SECONDS = 10 * 60

/**
 * How far ahead of this server's clock an `auth_time` may be before it counts
 * as "in the future". Firebase Auth and Cloud Functions keep separate clocks;
 * a sign-in that is seconds old must not be refused because the two disagree
 * by a second. Anything further ahead than this is refused.
 */
export const AUTH_TIME_CLOCK_SKEW_SECONDS = 60

export type LifecycleRefusal =
  | ''
  | typeof SESSION_DISPLACED
  | typeof SESSION_REQUIRED
  | typeof RECENT_SIGN_IN_REQUIRED

/**
 * Decide, without touching Firestore, whether this credential may move the
 * account through deletion. Returns the refusal code, or '' to proceed.
 */
export function lifecycleCredentialRefusal(p: {
  authTime: unknown
  nowSec: number
  credentialsValidAfter: unknown
  presentedSessionId: string
  recordedSessionId: string
  requireActiveSession: boolean
  maxSignInAgeSec?: number
}): LifecycleRefusal {
  const recentRequired = typeof p.maxSignInAgeSec === 'number'
  const authTime = typeof p.authTime === 'number' ? p.authTime : Number.NaN
  const authTimeValid = Number.isFinite(authTime)
    && authTime > 0
    && authTime <= p.nowSec + AUTH_TIME_CLOCK_SKEW_SECONDS
  if (!authTimeValid) return recentRequired ? RECENT_SIGN_IN_REQUIRED : SESSION_DISPLACED

  const cutoffRaw = Number(p.credentialsValidAfter)
  const cutoff = Number.isFinite(cutoffRaw) && cutoffRaw > 0 ? cutoffRaw : 0
  if (cutoff > 0 && authTime < cutoff) return SESSION_DISPLACED

  if (p.requireActiveSession || p.recordedSessionId !== '') {
    if (p.presentedSessionId === '' || p.recordedSessionId === '') return SESSION_REQUIRED
    if (p.presentedSessionId !== p.recordedSessionId) return SESSION_DISPLACED
  }

  if (recentRequired && p.nowSec - authTime > (p.maxSignInAgeSec as number)) {
    return RECENT_SIGN_IN_REQUIRED
  }
  return ''
}

const LIFECYCLE_MESSAGES: Record<Exclude<LifecycleRefusal, ''>, string> = {
  [SESSION_DISPLACED]:
    'This sign-in is no longer valid for your account. Sign in again, then try again.',
  [SESSION_REQUIRED]:
    'Your session on this device is not active. Sign in again, then try again.',
  [RECENT_SIGN_IN_REQUIRED]:
    'For your security, sign in again to delete your account now.',
}

/** Throw the refusal for this credential, if there is one. */
function refuseUnlessCurrentCredential(
  req: CallableRequest<Record<string, unknown>>,
  uid: string,
  snap: FirebaseFirestore.DocumentSnapshot,
  operation: string,
  opts: { requireActiveSession: boolean; maxSignInAgeSec?: number },
): void {
  const session = (snap.get('activeMobileSession') ?? {}) as Record<string, unknown>
  const refusal = lifecycleCredentialRefusal({
    authTime: req.auth?.token?.auth_time,
    nowSec: Math.floor(Date.now() / 1000),
    credentialsValidAfter: snap.get('credentialsValidAfter'),
    presentedSessionId: presentedSessionId(req.data),
    recordedSessionId: typeof session.sessionId === 'string' ? session.sessionId : '',
    requireActiveSession: opts.requireActiveSession,
    maxSignInAgeSec: opts.maxSignInAgeSec,
  })
  if (refusal === '') return
  logger.warn('account lifecycle refused', { uid, operation, refusal })
  throw new HttpsError(
    refusal === RECENT_SIGN_IN_REQUIRED ? 'failed-precondition' : 'permission-denied',
    LIFECYCLE_MESSAGES[refusal],
    { code: refusal },
  )
}

const PARTNER_CAPABILITIES = new Set(['agency', 'seller'])

/**
 * Partner statuses that leave nothing to protect. Every other status —
 * approved, pending, suspended, a missing one, or one this build does not
 * know — keeps the identity protected: the cost of a wrong "protected" is a
 * deletion that waits for an Owner; the cost of a wrong "not protected" is a
 * CRM login nobody can get back.
 */
const RELEASED_PARTNER_STATUSES = new Set(['rejected', 'revoked'])

export type ProtectedCrmAccess = '' | 'staff' | 'partner'

/** Pure: the protected CRM access a `crmUsers/{uid}` document grants, or ''. */
export function protectedCrmAccess(
  doc: Record<string, unknown> | null | undefined,
): ProtectedCrmAccess {
  if (!doc) return ''
  const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '')

  const role = norm(doc.role)
  if (role !== '' && !PARTNER_CAPABILITIES.has(role) && doc.isActive !== false) return 'staff'

  const statusOf = new Map<string, string>()
  const roleStatus = doc.roleStatus
  if (roleStatus && typeof roleStatus === 'object' && !Array.isArray(roleStatus)) {
    for (const [k, v] of Object.entries(roleStatus as Record<string, unknown>)) {
      statusOf.set(norm(k), norm(v))
    }
  }
  const capabilities = new Set<string>()
  if (PARTNER_CAPABILITIES.has(role)) capabilities.add(role)
  if (Array.isArray(doc.roles)) {
    for (const r of doc.roles) if (PARTNER_CAPABILITIES.has(norm(r))) capabilities.add(norm(r))
  }
  for (const k of statusOf.keys()) if (PARTNER_CAPABILITIES.has(k)) capabilities.add(k)

  for (const capability of capabilities) {
    let status = statusOf.get(capability) ?? ''
    // A login written before per-capability statuses existed carries one
    // status, at the top level, for its primary role.
    if (status === '' && capability === role) status = norm(doc.status)
    if (!RELEASED_PARTNER_STATUSES.has(status)) return 'partner'
  }
  return ''
}

async function protectedCrmAccessOf(uid: string): Promise<ProtectedCrmAccess> {
  const snap = await db.collection('crmUsers').doc(uid).get()
  return snap.exists ? protectedCrmAccess(snap.data() as Record<string, unknown>) : ''
}

const CRM_MESSAGES: Record<'staff' | 'partner', string> = {
  staff:
    'This login is also your Zipper CRM account, so it cannot be deleted from the app — ' +
    'that would remove your CRM access. Ask an Owner to remove your CRM access first.',
  partner:
    'This login also runs your Zipper partner account, so it cannot be deleted from the app — ' +
    'that would lock you out of it. Ask Zipper to close the partner account first.',
}

/** Throw CRM_ACCESS_HELD if this login is a protected CRM identity. */
async function refuseProtectedCrmIdentity(uid: string, operation: string): Promise<void> {
  const access = await protectedCrmAccessOf(uid)
  if (access === '') return
  logger.warn('account lifecycle refused: protected CRM identity', { uid, operation, access })
  throw new HttpsError('failed-precondition', CRM_MESSAGES[access], {
    code: CRM_ACCESS_HELD,
    access,
  })
}

// ── RC (confirmed): partner responsibilities block a self-deletion ──────────
//
// "Block self-deletion while partner responsibilities remain unresolved." The
// CRM-login check above covers staff and partner logins. A HOST is a partner
// role too, and a Host's responsibilities live on the app account itself:
//
//   host_role        — `isHost` is still true: the agency's roster, its weekly
//                      report and its commission all hang on this account;
//   money_frozen     — `payoutHold`: money behind a suspension, ban or
//                      revocation waits for the Owner's decision (CRM-FLOW 9.48);
//   unpaid_earnings  — beans released for withdrawal and not withdrawn;
//   open_withdrawal  — a withdrawal request still being paid.
//
// Deleting would leave each of those owed to, or by, nobody. The person ends
// the Host role (Zipper staff) or settles the money first. Financial and audit
// records are never deleted by a purge either way.

export const PARTNER_RESPONSIBILITIES = 'PARTNER_RESPONSIBILITIES'

export type DeletionBlocker = 'host_role' | 'money_frozen' | 'unpaid_earnings' | 'open_withdrawal'

/** Pure: what on the user document (plus open withdrawals) still needs settling. */
export function deletionBlockersOf(
  user: Record<string, unknown> | null | undefined,
  openWithdrawals = 0,
): DeletionBlocker[] {
  const u = user ?? {}
  const out: DeletionBlocker[] = []
  if (u.isHost === true) out.push('host_role')
  if (u.payoutHold === true) out.push('money_frozen')
  if (Number(u.beansAvailable ?? 0) > 0) out.push('unpaid_earnings')
  if (openWithdrawals > 0) out.push('open_withdrawal')
  return out
}

const BLOCKER_SENTENCE: Record<DeletionBlocker, string> = {
  host_role: 'you are still a Host — ask Zipper to end the Host role first',
  money_frozen: 'money on this account is on hold for Zipper\'s review',
  unpaid_earnings: 'you have earnings released for withdrawal — withdraw them first',
  open_withdrawal: 'a withdrawal is still being paid',
}

/** `HttpsError.details.code` when a deletion blocker could not be checked (F-21). */
export const DELETION_CHECK_UNAVAILABLE = 'DELETION_CHECK_UNAVAILABLE'

/** Withdrawal statuses that still have money in flight. */
const OPEN_WITHDRAWAL_STATUSES = ['pending', 'approved', 'processing']

/**
 * How many of this host's withdrawals are still being paid.
 *
 * F-21: FAILS CLOSED. This used to answer 0 on a read error, so a Firestore
 * hiccup at exactly the wrong moment let a deletion proceed past a withdrawal
 * that was still being paid — the one blocker whose cost is real money owed to
 * nobody. A check that could not run is not a check that passed: the callable
 * answers `unavailable` and writes nothing; the sweep logs the failure and
 * retries that account the next night (its due date is untouched).
 */
async function openWithdrawalsOf(uid: string): Promise<number> {
  let snap: FirebaseFirestore.QuerySnapshot
  try {
    snap = await db.collection('withdrawalRequests').where('hostUid', '==', uid).get()
  } catch (err) {
    logger.error('account lifecycle: open-withdrawal check failed; deletion blocked', {
      uid, err: String(err),
    })
    throw new HttpsError(
      'unavailable',
      'Your account could not be checked for withdrawals in progress. Please try again in a few minutes.',
      { code: DELETION_CHECK_UNAVAILABLE },
    )
  }
  return snap.docs.filter((d) => OPEN_WITHDRAWAL_STATUSES.includes(String(d.get('status') ?? ''))).length
}

/** Throw PARTNER_RESPONSIBILITIES if a Host's responsibilities are unsettled. */
async function refuseUnsettledPartnerResponsibilities(
  uid: string, user: Record<string, unknown>, operation: string,
): Promise<void> {
  const blockers = deletionBlockersOf(user, await openWithdrawalsOf(uid))
  if (blockers.length === 0) return
  logger.warn('account lifecycle refused: unsettled partner responsibilities', { uid, operation, blockers })
  throw new HttpsError(
    'failed-precondition',
    'This account cannot be deleted yet: ' + blockers.map((b) => BLOCKER_SENTENCE[b]).join('; ') + '.',
    { code: PARTNER_RESPONSIBILITIES, blockers },
  )
}

/** Firebase Auth's "no such user" — which, for a deletion, is success. */
function isUserNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'auth/user-not-found'
}

/**
 * Delete the Firebase login. "Already gone" is success; anything else is
 * thrown, so the caller fails and the account stays queued for a retry.
 */
async function deleteLogin(uid: string): Promise<void> {
  try {
    await admin.auth().deleteUser(uid)
  } catch (err) {
    if (isUserNotFound(err)) {
      logger.info(`purgeAccount: auth account ${uid} was already absent`)
      return
    }
    throw err
  }
}

/** Take a finished deletion out of the sweep's queue for good (DEACT-001). */
async function markPurgeComplete(uid: string): Promise<void> {
  await db.collection('users').doc(uid).update({
    deletionDueAt: admin.firestore.FieldValue.delete(),
    deletionHeld: admin.firestore.FieldValue.delete(),
  })
}

/**
 * The Cloud Storage prefixes a purge removes — the person's own uploads.
 *
 *   profileMedia/{uid}/       profile photos (the client's own uploads).
 *   hostVerification/{uid}/   F-10: the face-verification capture
 *                             (`capture.jpg`) and every `attempts/*` frame —
 *                             BIOMETRIC data (hosts.ts `captureObjectPath`).
 *                             It used to survive a "permanent" deletion.
 *
 * OWNER_DECISION_PENDING (audit 2026-11-01, open question 8): whether the
 * biometric captures should instead be retained for a fixed period for
 * dispute defence. The DEFAULT, implemented here, is delete at purge — a
 * capture of a person who has left is the heaviest thing the business can
 * hold with the least reason to hold it. If the owner decides otherwise,
 * drop the prefix here and add the retention period beside it.
 */
export function purgedStoragePrefixes(uid: string): string[] {
  return [`profileMedia/${uid}/`, `hostVerification/${uid}/`]
}

/**
 * Delete everything under each prefix. Returns the prefixes that could NOT be
 * cleared, so the caller can record the debt rather than forget it.
 */
async function clearStorage(uid: string, prefixes: string[]): Promise<string[]> {
  const left: string[] = []
  for (const prefix of prefixes) {
    try {
      await admin.storage().bucket().deleteFiles({ prefix })
    } catch (err) {
      left.push(prefix)
      logger.error(`purgeAccount: storage ${prefix} could not be cleared`, err)
    }
  }
  return left
}

/**
 * The prefixes a record still owes to Storage — only ones a purge of THIS
 * uid may delete, whatever the field holds.
 */
function pendingStoragePrefixes(uid: string, raw: unknown): string[] {
  const allowed = new Set(purgedStoragePrefixes(uid))
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string' && allowed.has(p)) : []
}

/**
 * Record what Storage still holds for this account, or clear the record.
 *
 * `storagePurgePending` is what makes a Storage failure a DEBT rather than an
 * orphan: the record stays queued (its due date is kept), the sweep returns to
 * it the next night, and `finishPurge` retries exactly these prefixes — and
 * only these, so a retry never re-lists what was already cleared.
 */
async function recordStorageDebt(uid: string, left: string[]): Promise<void> {
  await db.collection('users').doc(uid).set(
    { storagePurgePending: left.length > 0 ? left : admin.firestore.FieldValue.delete() },
    { merge: true },
  )
}

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
  /*
   * FX-10 (RF-15): the agency's roster row stops counting in the same write.
   * It used to stay, so the weekly payout report and the agency's screens —
   * which read the roster and nothing else — went on listing a purged account
   * as one of the agency's hosts. Marked inactive, not deleted: it is the
   * record of who was on the roster, like the `agencyId` kept below.
   */
  const userRef = db.collection('users').doc(uid)
  const before = await userRef.get()
  const rosterAgency = String((before.exists ? before.get('agencyId') : '') ?? '').trim()
  const rosterRef = rosterAgency
    ? db.collection('agencies').doc(rosterAgency).collection('agencyHosts').doc(uid)
    : null
  const rosterRow = rosterRef ? await rosterRef.get() : null
  const purgeWrite = db.batch()
  if (rosterRef && rosterRow?.exists && rosterRowIsCurrent(rosterRow.data())) {
    purgeWrite.update(
      rosterRef,
      rosterRemovalFields('purged', admin.firestore.FieldValue.serverTimestamp()),
    )
  }
  purgeWrite.set(
    userRef,
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
      // RC (confirmed): no active role survives a permanent deletion. The
      // flags are cleared; `agencyId` (history) and every financial and audit
      // record are kept.
      isHost: false,
      isVerifiedHost: false,
      isAgent: false,
      isSeller: false,
      crmRole: '',
    },
    { merge: true },
  )
  // RC (confirmed): the partner login (a released one — a live one never
  // reaches a purge) and any public seller listing go with the account.
  const crmRef = db.collection('crmUsers').doc(uid)
  const crmSnap = await crmRef.get()
  if (crmSnap.exists) purgeWrite.set(crmRef, { isActive: false, purgedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
  const ownSellers = await db.collection('sellers').where('ownerUid', '==', uid).get().catch(() => null)
  for (const s of ownSellers?.docs ?? []) {
    purgeWrite.delete(db.collection('publicSellers').doc(s.id))
  }
  await purgeWrite.commit()
  // B1 (DEACT-001): no longer swallowed. If the identity was not released, the
  // purge must FAIL, keep its due date and be retried — not delete the login,
  // clear the due date, and leave a phone number bound to an account nobody
  // can sign into.
  removed += 1

  // Uploaded media and (F-10) the biometric captures. A storage failure must
  // not leave the account half-deleted — the identity is already released and
  // the login still goes below — but it is no longer forgotten either: the
  // prefixes still owed are recorded, the record stays queued, and the sweep's
  // `finishPurge` retries them until Storage is clean.
  const storageLeft = await clearStorage(uid, purgedStoragePrefixes(uid))
  await recordStorageDebt(uid, storageLeft)

  // Last, for the reason above. Already gone is success; any other failure is
  // thrown, so the due date stays set and the sweep's next run finishes the
  // job with `finishPurge` — without repeating the steps above.
  await deleteLogin(uid)

  if (storageLeft.length > 0) {
    logger.error(
      `purgeAccount: ${uid} stays queued — Storage still holds ${storageLeft.join(', ')}; ` +
        'the sweep retries it',
    )
    return { uid, removed }
  }

  // Only now is the deletion complete: out of the queue for good (DEACT-001).
  await markPurgeComplete(uid)

  return { uid, removed }
}

/**
 * Finish a purge whose identity was already released — `accountState` is
 * `permanently_deactivated` — but which is still queued: a login deletion that
 * failed, a Storage prefix that could not be cleared (`storagePurgePending`),
 * or a record completed before DEACT-001 was fixed, when a purge never cleared
 * its due date. Repeats nothing that already happened: only the Storage
 * prefixes still recorded as owed are retried, the login is deleted only if it
 * still exists, and the record leaves the queue only once both are done.
 */
async function finishPurge(uid: string): Promise<void> {
  const snap = await db.collection('users').doc(uid).get()
  const owed = pendingStoragePrefixes(uid, snap.exists ? snap.get('storagePurgePending') : undefined)
  let storageLeft: string[] = []
  if (owed.length > 0) {
    storageLeft = await clearStorage(uid, owed)
    await recordStorageDebt(uid, storageLeft)
  }

  let loginExists = true
  try {
    await admin.auth().getUser(uid)
  } catch (err) {
    if (!isUserNotFound(err)) throw err
    loginExists = false
  }
  if (loginExists) await deleteLogin(uid)

  if (storageLeft.length > 0) {
    logger.error(
      `finishPurge: ${uid} stays queued — Storage still holds ${storageLeft.join(', ')}`,
    )
    return
  }
  await markPurgeComplete(uid)
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
  async (req: CallableRequest<Record<string, unknown>>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const ref = db.collection('users').doc(uid)
    const snap = await ref.get()
    if (!snap.exists) throw new HttpsError('not-found', 'No account to delete.')

    // B1 (N3): only the account's current sign-in, on its active session.
    refuseUnlessCurrentCredential(req, uid, snap, 'requestAccountDeletion', {
      requireActiveSession: true,
    })
    // B1 (STAFF-005): never a login the CRM depends on.
    await refuseProtectedCrmIdentity(uid, 'requestAccountDeletion')
    // RC (confirmed): nor one whose Host responsibilities are unsettled.
    await refuseUnsettledPartnerResponsibilities(uid, (snap.data() ?? {}) as Record<string, unknown>,
      'requestAccountDeletion')

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
        /*
         * Phase 1A (SESSION-003): removing the session id did not end the
         * session. Every ID token already issued kept passing
         * `sessionCurrent()` and kept calling callables for up to an hour,
         * and its refresh token kept minting more. The cut-off moves PAST
         * now (monotonic — never lowered), so every existing token is
         * refused by the rules, and the refresh tokens are revoked below.
         * Recovery signs in afresh, which mints a token after the cut-off.
         */
        credentialsValidAfter: Math.max(
          Number(snap.get('credentialsValidAfter') ?? 0) || 0,
          Math.floor(now.toMillis() / 1000) + 1,
        ),
      },
      { merge: true },
    )
    try {
      await admin.auth().revokeRefreshTokens(uid)
    } catch (err) {
      // Reported, not swallowed: the rules cut-off above already refuses the
      // live tokens; this only stops new ones being minted.
      logger.error('deletion request: refresh tokens NOT revoked', { uid, err: String(err) })
    }

    logger.info('account deletion requested', { uid, dueAt: dueAt.toMillis() })
    return { requested: true, alreadyDeleted: false, dueAtMs: dueAt.toMillis() }
  },
)

// ── Recover ───────────────────────────────────────────────────────────────────

/** `HttpsError.details.code` when the recovery window has closed (C8, B27). */
export const RECOVERY_EXPIRED = 'RECOVERY_EXPIRED'

/**
 * Has this account's recovery window closed?
 *
 * A due date AT now is closed, not open: the sweep purges `deletionDueAt <=
 * now`, and `resolveIdentity` answers `deleted_permanent` on the same test, so
 * all three agree on the boundary. No due date — including one the sweep moved
 * into `deletionHeld` (STAFF-005) — is not expired.
 */
export function recoveryExpired(
  dueAt: { toMillis?: () => number } | null | undefined,
  nowMs: number,
): boolean {
  return dueAt != null && typeof dueAt.toMillis === 'function' && dueAt.toMillis() <= nowMs
}

/**
 * Change your mind, within the recovery window (`GRACE_DAYS`).
 *
 * A callable rather than a client write, for the same reason every other state
 * change about an account is: it is recorded, and the rules do not have to be
 * widened to let a user edit their own deletion status.
 */
export const recoverAccount = onCall(
  { region: REGION },
  async (req: CallableRequest<Record<string, unknown>>) => {
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

    // B1 (N3): a sign-in made after the deletion request — the request moved
    // the cut-off past its own time, so every older token is refused.
    refuseUnlessCurrentCredential(req, uid, snap, 'recoverAccount', {
      requireActiveSession: false,
    })

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
     *
     * C8 (B27): decided on the DUE DATE as well as the state. The sweep that
     * flips the state runs once a day, fifty accounts at a time, so an account
     * can sit past its deadline still saying `recovery_pending` — and recovery
     * used to succeed there, into an account the sweep was about to purge.
     */
    if (
      snap.get('accountState') === STATE_PERMANENTLY_DEACTIVATED ||
      recoveryExpired(snap.get('deletionDueAt'), Date.now())
    ) {
      throw new HttpsError(
        'failed-precondition',
        'The recovery period for this account has passed. Its history is kept, ' +
          'but the account cannot be restored.',
        { code: RECOVERY_EXPIRED },
      )
    }

    await ref.update({
      accountState: STATE_ACTIVE,
      isDeleted: admin.firestore.FieldValue.delete(),
      deletionRequestedAt: admin.firestore.FieldValue.delete(),
      deletionDueAt: admin.firestore.FieldValue.delete(),
      // A hold placed by the sweep (STAFF-005) means nothing once recovered.
      deletionHeld: admin.firestore.FieldValue.delete(),
      recoveredAt: admin.firestore.FieldValue.serverTimestamp(),
    })

    logger.info('account recovered', { uid })
    return { recovered: true, alreadyActive: false }
  },
)

// ── Finish it now ─────────────────────────────────────────────────────────────

/**
 * Skip the grace period (DEACT-003: sixty days now, see `GRACE_DAYS`).
 *
 * Offered beside Recover, because somebody who has come back specifically to
 * confirm the deletion should not have to wait a month for it, and because an
 * account they intend to replace has to be gone before the same phone number
 * can sign up again.
 */
export const purgeMyAccountNow = onCall(
  { region: REGION },
  async (req: CallableRequest<Record<string, unknown>>) => {
    const uid = req.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.')

    const snap = await db.collection('users').doc(uid).get()
    if (!snap.exists) return { purged: true, alreadyGone: true }

    // B1 (N3): a sign-in made after the deletion request, and made within the
    // last ten minutes — this is the one irreversible step.
    refuseUnlessCurrentCredential(req, uid, snap, 'purgeMyAccountNow', {
      requireActiveSession: false,
      maxSignInAgeSec: DELETE_NOW_MAX_SIGN_IN_AGE_SECONDS,
    })

    // Only from the deleted state. Otherwise this is a one-call account
    // destructor reachable by anything holding a token.
    if (snap.get('isDeleted') !== true) {
      throw new HttpsError(
        'failed-precondition',
        'Request deletion from Settings first.',
      )
    }

    // B1 (STAFF-005): never a login the CRM depends on — including one whose
    // deletion was requested before this check existed.
    await refuseProtectedCrmIdentity(uid, 'purgeMyAccountNow')
    // RC (confirmed): nor one whose Host responsibilities are unsettled.
    await refuseUnsettledPartnerResponsibilities(uid, (snap.data() ?? {}) as Record<string, unknown>,
      'purgeMyAccountNow')

    // Identity already released, login deletion still pending: finish only
    // that, rather than repeating the purge (DEACT-001).
    if (snap.get('accountState') === STATE_PERMANENTLY_DEACTIVATED) {
      await finishPurge(uid)
      logger.info('account purge finished on request', { uid })
      return { purged: true, alreadyGone: false }
    }

    const result = await purgeAccount(uid)
    logger.info('account purged on request', result)
    return { purged: true, alreadyGone: false }
  },
)

// ── The grace-period sweep (GRACE_DAYS) ──────────────────────────────────────

/**
 * Finish deletions whose grace period has run out.
 *
 * Daily at 03:30 IST — after the nightly jobs, before anybody is awake to be
 * confused by an account disappearing mid-session.
 *
 * Bounded at fifty purges a run. This is not a queue that spikes, and a purge
 * does a dozen writes plus a storage listing per account; a sweep that tried to
 * clear a backlog in one pass would be the thing that took the database down.
 *
 * ── DEACT-001 (B1, Phase 1A.2) ───────────────────────────────────────────────
 *
 * A purge used to leave `isDeleted: true` AND its `deletionDueAt` behind, so
 * every completed deletion matched this query for ever. With fifty of them in
 * the queue, every run re-purged the same fifty and the next real deletion was
 * never reached. Now:
 *
 *   * a purge clears `deletionDueAt` once it has fully succeeded, so it leaves
 *     the queue (`markPurgeComplete`);
 *   * a record already purged but still queued — completed before this fix, or
 *     whose login deletion failed — is FINISHED, not purged again: its login is
 *     deleted only if it still exists, then it leaves the queue (`finishPurge`);
 *   * a protected CRM identity (STAFF-005) is never purged here. It is marked
 *     `deletionHeld` — reason, which access, its original due date, when — and
 *     taken out of the queue, so it cannot block the run either. It stays
 *     hidden and recoverable; once an Owner has removed the CRM access, the
 *     person can finish the deletion with "Delete now", or recover;
 *   * up to SWEEP_SCAN_LIMIT records are read per run, so a handful of failures
 *     at the front of the queue cannot stop the rest. A failure keeps its due
 *     date and is retried the next night.
 */
export const SWEEP_PURGE_LIMIT = 50
export const SWEEP_SCAN_LIMIT = 500

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
      .orderBy('deletionDueAt')
      .limit(SWEEP_SCAN_LIMIT)
      .get()

    let purged = 0
    let finished = 0
    let held = 0
    let failed = 0
    for (const doc of due.docs) {
      if (purged >= SWEEP_PURGE_LIMIT) break
      try {
        const access = await protectedCrmAccessOf(doc.id)
        if (access !== '') {
          await doc.ref.update({
            deletionHeld: {
              reason: 'crm_access',
              access,
              dueAt: doc.get('deletionDueAt') ?? null,
              heldAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            deletionDueAt: admin.firestore.FieldValue.delete(),
          })
          held++
          logger.error(
            `purgeDeletedAccounts: ${doc.id} is a protected CRM identity (${access}); ` +
              'its deletion is held until an Owner removes the CRM access',
          )
          continue
        }
        if (doc.get('accountState') === STATE_PERMANENTLY_DEACTIVATED) {
          await finishPurge(doc.id)
          finished++
          continue
        }
        // RC (confirmed): unsettled Host responsibilities hold the deletion,
        // exactly like a protected CRM identity — never purged around.
        const blockers = deletionBlockersOf(doc.data() as Record<string, unknown>, await openWithdrawalsOf(doc.id))
        if (blockers.length > 0) {
          await doc.ref.update({
            deletionHeld: {
              reason: 'partner_responsibilities',
              blockers,
              dueAt: doc.get('deletionDueAt') ?? null,
              heldAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            deletionDueAt: admin.firestore.FieldValue.delete(),
          })
          held++
          logger.error(`purgeDeletedAccounts: ${doc.id} has unsettled responsibilities (${blockers.join(', ')}); held`)
          continue
        }
        await purgeAccount(doc.id)
        purged++
      } catch (err) {
        // One account that will not delete must not stop the others. It keeps
        // its due date and is retried tomorrow.
        failed++
        logger.error(`purgeDeletedAccounts: ${doc.id} failed; retried next run`, err)
      }
    }

    if (purged + finished + held + failed > 0) {
      logger.info('purgeDeletedAccounts', { purged, finished, held, failed })
    }
    return null
  })

export { GRACE_DAYS }

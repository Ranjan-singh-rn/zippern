/**
 * QUICK LOGIN — the three callables, applying `quickLoginPolicy`.
 *
 * The decisions are in `quickLoginPolicy.ts`, which imports nothing and is
 * tested directly. This file is the plumbing: Firestore reads, signature
 * verification, rotation, rate limiting and audit.
 *
 * ── THE SHAPE OF A REDEMPTION ────────────────────────────────────────────────
 *
 *   1. client asks for a challenge           quickLoginChallenge()
 *   2. client signs it with its Keystore key (private half never leaves)
 *   3. client redeems                        redeemQuickLogin({token, challengeId, signature})
 *   4. server verifies the signature against the public key registered at mint
 *   5. server applies account state
 *   6. server rotates the credential and returns a custom token
 *
 * Step 4 is the whole point. Possession of the secret is not sufficient: the
 * holder must also produce a signature only the original handset can make, so a
 * secret lifted from a backup onto a second device authenticates nothing.
 *
 * ── WHAT IS NEVER WRITTEN ANYWHERE ───────────────────────────────────────────
 *
 * The raw secret, the signature, and the challenge value. The server keeps only
 * a SHA-256 of the secret (as the document id), and every log line and audit
 * entry carries a short fingerprint rather than a credential.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'

import {
  CHALLENGE_TTL_MS,
  CREDENTIAL_VERSION,
  MIN_SECRET_CHARS,
  QUICK_LOGIN_TTL_DAYS,
  destroysCredential,
  grantsSession,
  isReportableState,
  messageFor,
  nextFailureState,
  permitsAppeal,
  redemptionOutcome,
  statementProblem,
  type QuickLoginOutcome,
} from './quickLoginPolicy'

function store(): admin.firestore.Firestore {
  return admin.firestore()
}

const CREDENTIALS = 'quickLoginTokens'
const CHALLENGES = 'quickLoginChallenges'
const RATE = 'quickLoginRate'
const EVENTS = 'authEvents'
const APPEALS = 'appeals'

/** SHA-256 hex. The credential document id, so the raw secret is never stored. */
function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** A short, non-reversible handle for logs. Never enough to reconstruct. */
function fingerprint(value: string): string {
  return hash(value).slice(0, 12)
}

/**
 * Record an authentication event.
 *
 * ── Why this is a Firestore collection and not the audit log ────────────────
 *
 * The append-only audit log is MongoDB, written by `app.core.audit` in the
 * FastAPI process. A Cloud Function cannot reach it — that is a standing
 * architectural fact of this system, not a shortcut taken here. Writing these
 * to Firestore keeps them in the one place a function CAN write, closed to every
 * client, where the backend can read or ingest them.
 *
 * Never carries a secret, a signature or a challenge.
 */
async function recordEvent(
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await store().collection(EVENTS).add({
      event,
      at: admin.firestore.FieldValue.serverTimestamp(),
      ...fields,
    })
  } catch (err) {
    // An audit write must never cost the caller their sign-in.
    functions.logger.warn('authEvent not recorded', { event, err: String(err) })
  }
}

/**
 * Verify a signature over the challenge, using the key registered at mint.
 *
 * EC P-256 with SHA-256, the pair the Android Keystore generates. Returns false
 * on any malformed input rather than throwing: a caller sending rubbish gets a
 * refusal, not a stack trace and a 500.
 */
export function verifySignature(
  publicKeyPem: string,
  challenge: string,
  signatureB64: string,
): boolean {
  try {
    if (!publicKeyPem || !challenge || !signatureB64) return false
    return crypto.verify(
      'sha256',
      Buffer.from(challenge, 'utf8'),
      { key: publicKeyPem, dsaEncoding: 'der' },
      Buffer.from(signatureB64, 'base64'),
    )
  } catch {
    return false
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  1. The challenge
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Issue a one-time challenge for a quick-login attempt.
 *
 * Unauthenticated by necessity — the caller is not signed in yet, which is the
 * entire point of quick login. It discloses nothing: the response is random
 * bytes, and asking for one reveals no account, no device and no credential.
 *
 * Single-use and short-lived, which is what stops a captured signature being
 * replayed against a second redemption.
 */
export const quickLoginChallenge = functions
  .region('asia-south1')
  .https.onCall(async () => {
    const id = crypto.randomBytes(16).toString('base64url')
    const value = crypto.randomBytes(32).toString('base64url')

    await store().collection(CHALLENGES).doc(id).set({
      value,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CHALLENGE_TTL_MS),
      usedAt: null,
    })

    return { challengeId: id, challenge: value, expiresInMs: CHALLENGE_TTL_MS }
  })

// ══════════════════════════════════════════════════════════════════════════════
//  2. Minting — on an ordinary sign-out
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create (or replace) this device's quick-login credential.
 *
 * Authenticated: only the account itself can arrange to be let back in. Called
 * on ORDINARY sign-out and nowhere else — a displaced device must not mint one,
 * or the single-active-device rule has a restoration path straight through it.
 *
 * `publicKey` is the device's Keystore public half, in PEM. Without one there is
 * nothing to bind to, so the mint is refused rather than quietly producing the
 * old unbound credential again.
 */
export const mintQuickLoginToken = functions
  .region('asia-south1')
  .https.onCall(async (data: { deviceId?: string; publicKey?: string }, context) => {
    const uid = context.auth?.uid
    if (!uid) {
      throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')
    }

    const deviceId = String(data?.deviceId ?? '').slice(0, 128)
    const publicKey = String(data?.publicKey ?? '').trim()
    if (!publicKey.includes('BEGIN PUBLIC KEY')) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'A device key is required for quick sign-in.',
      )
    }

    const userSnap = await store().collection('users').doc(uid).get()
    if (!userSnap.exists) {
      throw new functions.https.HttpsError('not-found', 'No profile for this account.')
    }
    /*
     * ── A RESTRICTED ACCOUNT MAY STILL MINT ONE. A DELETED ONE MAY NOT ──────
     *
     * This refused a banned account, on the reasoning that it may not arrange
     * its own way back in. The reasoning was right and the conclusion was wrong,
     * because the credential is no longer a way back in: `accountVerdict`
     * returns `banned`, `grantsSession` is false, no custom token is minted, and
     * the Firebase login is disabled independently.
     *
     * What it IS, for a restricted account, is the only proof of identity left —
     * the thing `submitAccountAppeal` verifies a signature against. Refusing the
     * mint here mattered most in the worst case: somebody banned mid-session,
     * whose app tears the session down and tries to mint on the way out, and who
     * would otherwise reach the ban screen holding nothing.
     *
     * Deletion still refuses. Recovery is its own flow with its own proof, and
     * an account on its way to being purged should not be issued credentials.
     */
    if (userSnap.get('isDeleted') === true) {
      throw new functions.https.HttpsError('failed-precondition', 'This account is being deleted.')
    }

    const secret = crypto.randomBytes(32).toString('base64url')
    await writeCredential(uid, secret, deviceId, publicKey)

    // Retire every other credential this account holds for this device, so one
    // device holds exactly one key. Done AFTER the new one lands, so a failure
    // here leaves a usable credential rather than none.
    await retireOthers(uid, deviceId, hash(secret))

    await recordEvent('QUICK_LOGIN_CREATED', {
      uid,
      deviceFingerprint: fingerprint(deviceId),
      credential: fingerprint(secret),
    })

    return {
      token: secret,
      displayName: String(userSnap.get('name') ?? ''),
      photoUrl: String(userSnap.get('photoUrl') ?? ''),
      expiresAtMs: Date.now() + QUICK_LOGIN_TTL_DAYS * 24 * 60 * 60 * 1000,
    }
  })

/**
 * The stored shape of a credential.
 *
 * Factored out so the plain write and the transactional rotation below produce
 * byte-identical documents. Two places constructing this by hand is how one of
 * them ends up missing `version` and silently becomes a legacy record.
 */
function credentialDocument(
  uid: string,
  deviceId: string,
  publicKey: string,
): Record<string, unknown> {
  return {
    version: CREDENTIAL_VERSION,
    uid,
    deviceId,
    publicKey,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(
      Date.now() + QUICK_LOGIN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ),
    lastUsedAt: null,
    revokedAt: null,
  }
}

async function writeCredential(
  uid: string,
  secret: string,
  deviceId: string,
  publicKey: string,
): Promise<void> {
  await store()
    .collection(CREDENTIALS)
    .doc(hash(secret))
    .set(credentialDocument(uid, deviceId, publicKey))
}

async function retireOthers(uid: string, deviceId: string, keepHash: string): Promise<void> {
  if (!deviceId) return
  const prior = await store()
    .collection(CREDENTIALS)
    .where('uid', '==', uid)
    .where('deviceId', '==', deviceId)
    .limit(20)
    .get()
  await Promise.all(
    prior.docs
      .filter((d) => d.id !== keepHash)
      .map((d) => d.ref.delete().catch(() => undefined)),
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  3. Redemption
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Spend a quick-login credential.
 *
 * Unauthenticated, necessarily. Everything that makes it safe is below: a
 * signature the caller can only produce on the original device, a single-use
 * challenge, account state, a per-binding rate limit, and rotation on success.
 */
export const redeemQuickLogin = functions
  .region('asia-south1')
  .https.onCall(async (data: {
    token?: string
    challengeId?: string
    signature?: string
    deviceId?: string
  }) => {
    const secret = String(data?.token ?? '')
    const challengeId = String(data?.challengeId ?? '')
    const signature = String(data?.signature ?? '')
    const deviceId = String(data?.deviceId ?? '').slice(0, 128)
    const now = Date.now()

    if (secret.length < MIN_SECRET_CHARS) {
      throw refuse('refused')
    }

    const credHash = hash(secret)
    const rateRef = store().collection(RATE).doc(credHash)
    const credRef = store().collection(CREDENTIALS).doc(credHash)

    const [rateSnap, credSnap] = await Promise.all([rateRef.get(), credRef.get()])
    const credential = credSnap.exists ? credSnap.data() : null

    // Consume the challenge before anything is decided, so a replay of the same
    // (challenge, signature) pair cannot be attempted twice even if the first
    // attempt failed for another reason.
    const challenge = await consumeChallenge(challengeId, now)

    const signatureValid =
      challenge !== null &&
      verifySignature(String(credential?.publicKey ?? ''), challenge, signature)

    const uid = String(credential?.uid ?? '')
    const [accountSnap, deviceBanned] = await Promise.all([
      uid ? store().collection('users').doc(uid).get() : Promise.resolve(null),
      isDeviceBanned(deviceId),
    ])

    const outcome = redemptionOutcome({
      rate: rateSnap.exists ? rateSnap.data() : null,
      credential,
      account: accountSnap?.exists ? accountSnap.data() : null,
      deviceBanned,
      signatureValid,
      nowMs: now,
    })

    if (!grantsSession(outcome)) {
      return handleRefusal(outcome, {
        uid,
        credHash,
        credRef,
        rateRef,
        rateSnap,
        deviceId,
        now,
        banReason: String(accountSnap?.get('banReason') ?? ''),
        suspendedUntil: accountSnap?.get('suspendedUntil') ?? null,
        displayName: String(accountSnap?.get('name') ?? ''),
        accountState: String(accountSnap?.get('accountState') ?? ''),
      })
    }

    /*
     * ── SUCCESS: CONSUME AND ROTATE, ATOMICALLY ──────────────────────────────
     *
     * This used to be three sequential writes — write the replacement, delete
     * the old credential, delete the rate record — on top of a `credRef.get()`
     * taken outside any transaction. Two redemptions of one secret carrying
     * DIFFERENT challenges therefore both read the credential as live, both
     * verified, and both succeeded: two custom tokens, and one ORPHANED
     * replacement credential nothing would rotate or clean for thirty days.
     *
     * "Single-use" held sequentially and not concurrently, which is not what
     * single-use means.
     *
     * The transaction below re-reads the credential and makes its existence the
     * thing being competed for. Reads precede writes, as Firestore requires, so
     * exactly one caller can observe it present and consume it; the other finds
     * it gone and loses cleanly, having changed nothing.
     *
     * The challenge transaction above is still needed and still does a different
     * job: it stops the SAME challenge being spent twice. This one stops the
     * same CREDENTIAL being spent twice. Neither subsumes the other.
     */
    const replacement = crypto.randomBytes(32).toString('base64url')
    const replacementRef = store().collection(CREDENTIALS).doc(hash(replacement))

    let consumed = false
    try {
      await store().runTransaction(async (tx) => {
        const fresh = await tx.get(credRef)
        // Lost the race, or revoked in the microseconds since the first read.
        // Returning without writing is what makes the loser harmless.
        if (!fresh.exists) return

        tx.delete(credRef)
        tx.set(
          replacementRef,
          credentialDocument(
            uid,
            String(fresh.get('deviceId') ?? deviceId),
            String(fresh.get('publicKey') ?? ''),
          ),
        )
        // The counter goes with the credential it belonged to.
        tx.delete(rateRef)
        consumed = true
      })
    } catch (err) {
      /*
       * A transaction that could not commit has written nothing, so the
       * credential is still live and the caller may simply try again. Reported
       * as `aborted` rather than a refusal for exactly that reason.
       */
      functions.logger.warn('quick login rotation could not commit', {
        uid, err: String(err),
      })
      throw concurrent()
    }

    if (!consumed) {
      await recordEvent('QUICK_LOGIN_RACE_LOST', {
        uid,
        deviceFingerprint: fingerprint(deviceId),
        credential: credHash.slice(0, 12),
      })
      throw concurrent()
    }

    let customToken: string
    try {
      customToken = await admin.auth().createCustomToken(uid)
    } catch (err) {
      functions.logger.error('quick login could not mint a token', { uid, err: String(err) })
      throw new functions.https.HttpsError('internal', 'Could not complete sign-in.')
    }

    await recordEvent('QUICK_LOGIN_SUCCESS', {
      uid,
      deviceFingerprint: fingerprint(deviceId),
      consumed: fingerprint(secret),
      issued: fingerprint(replacement),
    })
    await recordEvent('QUICK_LOGIN_ROTATED', { uid, issued: fingerprint(replacement) })

    return {
      outcome: 'allow' as const,
      customToken,
      token: replacement,
      uid,
      displayName: String(accountSnap?.get('name') ?? ''),
      photoUrl: String(accountSnap?.get('photoUrl') ?? ''),
      isProfileComplete: accountSnap?.get('isProfileComplete') === true,
      expiresAtMs: now + QUICK_LOGIN_TTL_DAYS * 24 * 60 * 60 * 1000,
    }
  })

/**
 * Read and consume a challenge. Returns its value, or null if unusable.
 *
 * Consumption is a transaction so two simultaneous redemptions cannot both
 * claim the same challenge — which is precisely the replay this exists to stop.
 */
async function consumeChallenge(id: string, nowMs: number): Promise<string | null> {
  if (!id) return null
  const ref = store().collection(CHALLENGES).doc(id)
  try {
    return await store().runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return null
      if (snap.get('usedAt')) return null
      const expiry = (snap.get('expiresAt') as admin.firestore.Timestamp | null)?.toMillis?.()
      if (typeof expiry === 'number' && expiry <= nowMs) return null
      tx.update(ref, { usedAt: admin.firestore.FieldValue.serverTimestamp() })
      return String(snap.get('value') ?? '') || null
    })
  } catch {
    return null
  }
}

async function isDeviceBanned(deviceId: string): Promise<boolean> {
  if (!deviceId) return false
  try {
    const snap = await store().collection('bannedDevices').doc(deviceId).get()
    return snap.exists && snap.get('isActive') !== false
  } catch {
    // A ban lookup that fails must not open the door. Phase A made the splash
    // fail closed for the same reason.
    return true
  }
}

async function handleRefusal(
  outcome: QuickLoginOutcome,
  ctx: {
    uid: string
    credHash: string
    credRef: admin.firestore.DocumentReference
    rateRef: admin.firestore.DocumentReference
    rateSnap: admin.firestore.DocumentSnapshot
    deviceId: string
    now: number
    banReason: string
    suspendedUntil: unknown
    displayName: string
    accountState: string
  },
): Promise<never | Record<string, unknown>> {
  if (destroysCredential(outcome)) {
    await ctx.credRef.delete().catch(() => undefined)
    await recordEvent('QUICK_LOGIN_REVOKED', {
      uid: ctx.uid,
      reason: outcome,
      credential: ctx.credHash.slice(0, 12),
    })
  }

  /*
   * ── BAN AND SUSPENSION ARE REFUSALS THAT ARE NOT FAILURES ────────────────
   *
   * The credential was valid and the device proved itself, so the answer is not
   * "no" — it is "here is what has happened to your account, and here is how to
   * appeal it". They RETURN rather than throw so the app can render the right
   * screen, the right dates and the appeal state from one payload.
   *
   * Neither grants a session or a custom token, and the Firebase login is
   * disabled independently by the CRM's own action. The only thing this payload
   * enables is `submitAccountAppeal`, below.
   *
   * Ban used to throw here, and the credential used to be destroyed on the way
   * past. That left a banned person holding nothing: no session (Phase A revoked
   * it), no credential, and an appeal form that is an authenticated write.
   */
  if (isReportableState(outcome)) {
    await recordEvent('QUICK_LOGIN_ACCOUNT_STATE_BLOCKED', {
      uid: ctx.uid,
      state: outcome,
      deviceFingerprint: fingerprint(ctx.deviceId),
    })
    const until = (ctx.suspendedUntil as { toMillis?(): number } | null)?.toMillis?.()
    return {
      outcome,
      uid: ctx.uid,
      displayName: ctx.displayName,
      reason: ctx.banReason,
      suspendedUntilMs: outcome === 'suspended' && typeof until === 'number' ? until : null,
      message: messageFor(outcome, ctx.banReason),
      canAppeal: permitsAppeal(outcome),
      appeal: await appealStateFor(ctx.uid),
    }
  }

  // Everything else counts against the binding and is refused.
  if (outcome !== 'rate_limited') {
    const next = nextFailureState(ctx.rateSnap.exists ? ctx.rateSnap.data() : null, ctx.now)
    await ctx.rateRef
      .set(
        {
          failures: next.failures,
          lockedUntil: next.lockedUntilMs
            ? admin.firestore.Timestamp.fromMillis(next.lockedUntilMs)
            : null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .catch(() => undefined)
  }

  await recordEvent(
    outcome === 'device_banned' || outcome === 'deleted'
      ? 'QUICK_LOGIN_ACCOUNT_STATE_BLOCKED'
      : outcome === 'refused'
        ? 'QUICK_LOGIN_DEVICE_MISMATCH'
        : 'QUICK_LOGIN_FAILED',
    {
      uid: ctx.uid || null,
      outcome,
      deviceFingerprint: fingerprint(ctx.deviceId),
    },
  )

  throw refuse(outcome, ctx.banReason)
}

function refuse(outcome: QuickLoginOutcome, banReason = ''): functions.https.HttpsError {
  return new functions.https.HttpsError(
    'permission-denied',
    messageFor(outcome, banReason),
    { code: outcome },
  )
}

/**
 * The loser of a rotation race, and why it is not a refusal.
 *
 * `aborted` rather than `permission-denied`, and a detail code that is NOT one
 * of the `QuickLoginOutcome` values, deliberately:
 *
 *   - The caller did nothing wrong. Nothing counts against the rate limit.
 *   - The credential was not rejected, it was spent — by the winner, which on
 *     this path is the same device — so the device already holds the rotated
 *     replacement from the winning response.
 *   - `AuthRepository.refuseQuickLogin` routes an unrecognised detail code to
 *     its `else` branch, which reports the message and KEEPS the local
 *     credential. A `refused` detail would have made the loser clear the
 *     replacement the winner had just saved, turning a harmless race into a
 *     lost credential.
 *
 * So this needs no Android change, and the client's existing conservatism about
 * unknown codes is exactly the right behaviour here.
 */
function concurrent(): functions.https.HttpsError {
  return new functions.https.HttpsError(
    'aborted',
    'Another sign-in for this account is already in progress. Please try again.',
    { code: 'concurrent' },
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  4. Revocation
// ══════════════════════════════════════════════════════════════════════════════

/** Drop this device's credential, or every one this account holds. */
export const revokeQuickLogin = functions
  .region('asia-south1')
  .https.onCall(async (data: { token?: string; allDevices?: boolean }, context) => {
    const uid = context.auth?.uid
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Sign in first.')

    if (data?.allDevices === true) {
      const all = await store().collection(CREDENTIALS).where('uid', '==', uid).limit(100).get()
      await Promise.all(all.docs.map((d) => d.ref.delete().catch(() => undefined)))
      await recordEvent('QUICK_LOGIN_REVOKED', { uid, reason: 'all_devices', count: all.size })
      return { revoked: all.size }
    }

    const secret = String(data?.token ?? '')
    if (secret.length < MIN_SECRET_CHARS) return { revoked: 0 }
    const ref = store().collection(CREDENTIALS).doc(hash(secret))
    const snap = await ref.get()
    // Only your own. A credential you do not own is not yours to retire.
    if (snap.exists && snap.get('uid') === uid) {
      await ref.delete()
      await recordEvent('QUICK_LOGIN_REVOKED', { uid, reason: 'forget_device' })
      return { revoked: 1 }
    }
    return { revoked: 0 }
  })

// ══════════════════════════════════════════════════════════════════════════════
//  5. The appeal — A5, and the reason it had to exist
// ══════════════════════════════════════════════════════════════════════════════

/**
 * APPEALING WITH NO SESSION.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────
 *
 * `AppealRepository` on Android files an appeal as a Firestore write, and
 * `firestore.rules` requires `raisedByUid == request.auth.uid`. That was
 * workable while a banned person stayed signed in — the repository's own heading
 * still says so.
 *
 * It is no longer true. `set_user_disabled(uid, True)` disables the Firebase
 * login AND revokes its refresh tokens, so the session is gone within the
 * second. The appeal form on the banned screen became a form that could not
 * submit, and the person a reviewer most needs to hear from — the one banned by
 * mistake — had no way to say so.
 *
 * ── WHAT IDENTIFIES THE APPELLANT ────────────────────────────────────────────
 *
 * The same thing that identifies them to `redeemQuickLogin`: a signature over a
 * server-issued challenge, from a key held in this handset's Keystore and
 * registered against the credential when it was minted.
 *
 * That is a stronger claim than a session would be. A session says "somebody
 * holds a token for this account". This says "somebody is holding the physical
 * device this account was last signed out from", and the private half cannot be
 * copied, exported or restored onto another phone.
 *
 * ── WHAT IT CANNOT DO ────────────────────────────────────────────────────────
 *
 * Anything but file one appeal. No session, no custom token, no read of the
 * account, and `status` is written as `pending` by the server — the verdict
 * comes from `POST /users/appeals/{id}/decide`, where it is audited and where a
 * four-eyes check stops the person who made the original decision from also
 * deciding the appeal against it.
 *
 * Written with the Admin SDK, which is what lets it bypass the rules' `auth.uid`
 * requirement. The field set matches `appealFields()` in `firestore.rules`
 * exactly, so the CRM reads one shape whichever route an appeal arrived by.
 */
export const submitAccountAppeal = functions
  .region('asia-south1')
  .https.onCall(async (data: {
    token?: string
    challengeId?: string
    signature?: string
    deviceId?: string
    statement?: string
  }) => {
    const secret = String(data?.token ?? '')
    const challengeId = String(data?.challengeId ?? '')
    const signature = String(data?.signature ?? '')
    const deviceId = String(data?.deviceId ?? '').slice(0, 128)
    const statement = String(data?.statement ?? '').trim()
    const now = Date.now()

    if (secret.length < MIN_SECRET_CHARS) throw refuse('refused')

    /*
     * The statement is checked FIRST, before the challenge is consumed.
     *
     * A statement that is too short is the one error a person can fix by
     * retyping, and burning their single-use challenge on it would make them ask
     * for a new one they cannot see. Nothing is disclosed by checking it early:
     * the answer depends only on what they sent.
     */
    const problem = statementProblem(statement)
    if (problem) throw new functions.https.HttpsError('invalid-argument', problem)

    const credHash = hash(secret)
    const rateRef = store().collection(RATE).doc(credHash)
    const credRef = store().collection(CREDENTIALS).doc(credHash)
    const [rateSnap, credSnap] = await Promise.all([rateRef.get(), credRef.get()])
    const credential = credSnap.exists ? credSnap.data() : null

    const challenge = await consumeChallenge(challengeId, now)
    const signatureValid =
      challenge !== null &&
      verifySignature(String(credential?.publicKey ?? ''), challenge, signature)

    const uid = String(credential?.uid ?? '')
    const accountSnap = uid ? await store().collection('users').doc(uid).get() : null

    const outcome = redemptionOutcome({
      rate: rateSnap.exists ? rateSnap.data() : null,
      credential,
      account: accountSnap?.exists ? accountSnap.data() : null,
      /*
       * ── THE DEVICE BAN IS DELIBERATELY NOT CONSULTED HERE ────────────────
       *
       * Not an oversight, and not a shortcut: `isDeviceBanned` is deliberately
       * not called, and `false` is passed on purpose.
       *
       * A device ban and an account ban are different facts about different
       * things. Somebody whose account was banned AND whose handset was barred
       * has two problems, and refusing to hear about the first because of the
       * second conflates them — it would mean the people under the most
       * moderation are the ones who cannot appeal any of it.
       *
       * Nothing is weakened by this. The signature still has to verify, the
       * account still has to be in an appealable state, and the only thing that
       * can be done is to file one appeal for a human to read. A barred handset
       * gains no access from being allowed to say something.
       */
      deviceBanned: false,
      signatureValid,
      nowMs: now,
    })

    /*
     * Only a state that is actually appealable, and `permitsAppeal` is the one
     * place that decides which those are.
     *
     * Note what `allow` does here: it is refused too. An account in good
     * standing filing a "ban appeal" has nothing to appeal, and accepting it
     * would put noise in the queue that delays every real appeal behind it. The
     * message says to sign in, which is what that person should do.
     */
    if (!permitsAppeal(outcome)) {
      const failure = nextFailureState(rateSnap.exists ? rateSnap.data() : null, now)
      await rateRef
        .set(
          {
            failures: failure.failures,
            lockedUntil: failure.lockedUntilMs
              ? admin.firestore.Timestamp.fromMillis(failure.lockedUntilMs)
              : null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        )
        .catch(() => undefined)

      await recordEvent('ACCOUNT_APPEAL_REFUSED', {
        uid: uid || null,
        outcome,
        deviceFingerprint: fingerprint(deviceId),
      })

      if (outcome === 'allow') {
        throw new functions.https.HttpsError(
          'failed-precondition',
          'This account is not restricted. Please sign in.',
          { code: 'not_restricted' },
        )
      }
      throw refuse(outcome, String(accountSnap?.get('banReason') ?? ''))
    }

    /*
     * One pending appeal per account.
     *
     * Filing a second does not make the first go faster, and a queue of
     * duplicates from one person delays every other appeal in it. Checked on the
     * SERVER as well as on the device, because the device's check needed a
     * session to run and this path has none.
     */
    const existing = await appealStateFor(uid)
    if (existing.status === 'pending') {
      await recordEvent('ACCOUNT_APPEAL_DUPLICATE', { uid })
      return { status: 'already_pending' as const, appeal: existing }
    }

    const name = String(accountSnap?.get('name') ?? '')
    const written = await store().collection(APPEALS).add({
      subjectUid: uid,
      subjectName: name,
      raisedByUid: uid,
      raisedByName: name,
      raisedByRole: 'self',
      agencyId: '',
      kind: 'ban',
      reportId: '',
      statement,
      // No evidence on this path, deliberately: Cloud Storage rules require a
      // signed-in caller, and there is none. The statement is the part a
      // reviewer reads, and a half-working upload would be worse than none.
      evidenceUrls: [],
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      originalDecidedBy: '',
    })

    await recordEvent('ACCOUNT_APPEAL_SUBMITTED', {
      uid,
      state: outcome,
      appealId: written.id,
      deviceFingerprint: fingerprint(deviceId),
      // The statement itself is NOT recorded here. It is in the appeal document,
      // which is where a reviewer reads it; copying it into the auth event would
      // put somebody's account of what happened to them in a second place with
      // different retention.
      statementChars: statement.length,
    })

    // A successful appeal clears the failure counter. The person proved the
    // device and said something a reviewer can act on; holding earlier typos
    // against them would eventually lock them out of appealing at all.
    await rateRef.delete().catch(() => undefined)

    return { status: 'submitted' as const, appealId: written.id }
  })

/**
 * The state of this account's appeals, for a caller with no session.
 *
 * Returned inside the ban and suspension payloads so the screen can say "we have
 * it, it is with a reviewer" rather than showing an empty box that invites the
 * same words again — which is what the authenticated `pendingAppeal()` does for
 * everybody else.
 *
 * Carries the last DECISION too. Somebody whose appeal was refused should be told
 * so on that screen rather than filing the same appeal into the same queue.
 */
async function appealStateFor(uid: string): Promise<{
  status: 'none' | 'pending' | 'decided'
  decision: string
  decidedNote: string
}> {
  const none = { status: 'none' as const, decision: '', decidedNote: '' }
  if (!uid) return none

  /*
   * ── TWO QUERIES, AND THE ORDER IS ABOUT INDEXES ──────────────────────────
   *
   * The pending check is equality-only — `subjectUid` and `status` — which
   * Firestore serves by merging single-field indexes and needs no composite
   * index. The dedupe is the part that must not fail, so it is the part that
   * depends on nothing.
   *
   * The last-decision read is `where(...) + orderBy(createdAt desc)`, which DOES
   * need a composite index. One is now declared in `firestore.indexes.json`; if
   * it has not been built yet the read throws, and the catch below degrades to
   * "no decision to show" rather than taking the whole payload down with it.
   *
   * `AppealRepository.myAppeals()` on Android runs exactly that ordered query
   * inside `catch { emptyList() }`, with no index declared until now — so it has
   * most likely been returning nothing all along, silently. See the report.
   */
  let pending = false
  try {
    const open = await store()
      .collection(APPEALS)
      .where('subjectUid', '==', uid)
      .where('status', '==', 'pending')
      .limit(1)
      .get()
    pending = !open.empty
  } catch (err) {
    /*
     * A read that failed is not a "no appeal" — but it is reported as one, and
     * that is the lesser harm in this direction. `none` shows the form, so the
     * worst case is a duplicate appeal. Reporting `pending` on a failed read
     * would tell somebody they had already appealed when they had not, and they
     * would wait for a reviewer who has nothing.
     */
    functions.logger.warn('appeal pending-check unavailable', { uid, err: String(err) })
    return none
  }
  if (pending) return { status: 'pending', decision: '', decidedNote: '' }

  try {
    const last = await store()
      .collection(APPEALS)
      .where('subjectUid', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    if (last.empty) return none
    const doc = last.docs[0]
    const status = String(doc.get('status') ?? '')
    if (!status || status === 'pending') return none
    return {
      status: 'decided',
      decision: status,
      decidedNote: String(doc.get('decisionNote') ?? ''),
    }
  } catch (err) {
    // Missing index, most likely. Costs the person the sentence explaining what
    // came of their last appeal; costs them nothing they need to appeal again.
    functions.logger.warn('appeal history unavailable', { uid, err: String(err) })
    return none
  }
}

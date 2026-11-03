/**
 * ABUSE LIMITS FOR THE UNAUTHENTICATED CALLABLES (audit 2026-11-01, F-8).
 *
 * Six callables run with no signed-in caller, by design: `quickLoginChallenge`,
 * `redeemQuickLogin`, `submitAccountAppeal`, `claimGuestIdentity`, (QA #55)
 * `quickLoginRestriction` and (B10) `forgetQuickLogin`. Each one
 * costs Firestore reads and writes (a challenge is one document per call; a
 * guest claim is four to eight reads, Auth lookups and a transaction), and none
 * of them had anything between a script and that cost. This module is that
 * something: a budget per DEVICE and per client IP, kept in
 * `rateLimits/{bucket}`.
 *
 * One signed-in scope uses it too: `hostInvitationLookup`, shared by
 * `checkReferralCode` and `activateHost` (security review, 3 Nov 2026), keyed
 * by the account instead of a device id.
 *
 * ── What it is and is not ────────────────────────────────────────────────────
 *
 * It is a cost bound. A legitimate client makes one or two of these calls per
 * app start and a handful on a bad network; the defaults below (RATE_LIMIT_
 * POLICIES) are far above that and a person will never meet them. A script
 * meets them in seconds and is answered `resource-exhausted` from then on,
 * which bounds both the Firestore bill and the litter in `quickLoginChallenges`.
 *
 * It is NOT an identity control. The device id is client-supplied and the
 * client IP is whatever the request arrived from; both can be rotated by
 * somebody determined. The control that cannot be rotated is App Check —
 * `ENFORCE_APP_CHECK` below is the plumbing for it, off until the app ships
 * attestation and the console is configured (a client+console change).
 *
 * ── The bucket: a fixed window, counted with atomic increments ───────────────
 *
 *   rateLimits/{scope}:{kind}:{hash}:{windowStartMs}
 *     { scope, kind, count, windowStartMs, expiresAt }
 *
 * `scope` is the callable; `kind` is `dev` or `ip`; `hash` is a SHA-256 prefix
 * of the device id or the address — the raw value is never stored and never
 * logged (F-21 logging hygiene). A key may make `limit` calls per `windowMs`;
 * the count is read, and if under the limit, bumped with
 * `FieldValue.increment(1)`. Two concurrent calls can both read "9 of 10" and
 * both be admitted — an overshoot bounded by how many requests are in flight
 * at the boundary, which for a cost bound is the right trade.
 *
 * WHY NOT A TRANSACTIONAL TOKEN BUCKET. A read-decrement-write transaction is
 * exact, but under contention the SDK retries with a backoff that starts at a
 * second. Two places make that worse than inexact: a carrier NAT puts
 * thousands of handsets behind one address, so the per-IP document would be a
 * hot document whose contention delayed every sign-in behind it; and a device
 * that double-fires `redeemQuickLogin` would have its second call delayed past
 * the first one's rotation, read the credential as gone, and be told
 * `refused` — which the Android client answers by clearing the replacement
 * credential the first call had just saved (see `concurrent()` in
 * quickLogin.ts). Increments never abort and never wait.
 *
 * ── Failure modes, decided rather than defaulted ─────────────────────────────
 *
 * A Firestore failure while reading or bumping a bucket ALLOWS the call, with
 * a warning. The callable's own Firestore work is about to fail for the same
 * reason, and refusing every sign-in during a Firestore blip buys nothing. A
 * refusal writes nothing, so a flood costs one read per call and leaves no
 * litter.
 *
 * `expiresAt` (a day past the window) is on every bucket so a Firestore TTL
 * policy on `rateLimits.expiresAt` can be enabled from the console (optional);
 * the nightly `sweepQuickLoginTokens` deletes expired buckets regardless.
 */

import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'

export const RATE_LIMITS = 'rateLimits'

/** `HttpsError.details.code` when a key is over its budget. */
export const RATE_LIMITED = 'RATE_LIMITED'

/** `HttpsError.details.code` when App Check is enforced and no valid token came. */
export const APP_CHECK_REQUIRED = 'APP_CHECK_REQUIRED'

export interface BucketPolicy {
  /** Calls a key may make per window. */
  limit: number
  /** The window, in milliseconds. */
  windowMs: number
}

export interface RateLimitPolicy {
  perDevice?: BucketPolicy
  perIp?: BucketPolicy
}

const MINUTE = 60_000

/**
 * Conservative defaults — generous to a person, meaningful to a script.
 *
 *   quickLoginChallenge  no device id is sent (the app calls it with an empty
 *                        payload), so the IP budget is the only one. Carrier
 *                        NAT puts many handsets behind one address, so it is
 *                        the widest: 120 a minute.
 *   redeemQuickLogin     one or two per app start; retries on a bad network.
 *   submitAccountAppeal  one per restriction, by hand, with a statement.
 *   claimGuestIdentity   one or two per first launch.
 *   hostInvitationLookup signed in; keyed by the account — see the entry.
 *
 * Per-device budgets are the tight ones; per-IP budgets are deliberately wide
 * for the NAT reason above and exist to bound a script that rotates device
 * ids. Tighten a figure only with the "unverified requests" App Check metric
 * and the function's invocation count in front of you.
 */
export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  quickLoginChallenge: { perIp: { limit: 120, windowMs: MINUTE } },
  redeemQuickLogin: {
    perDevice: { limit: 10, windowMs: MINUTE },
    perIp: { limit: 60, windowMs: MINUTE },
  },
  submitAccountAppeal: {
    perDevice: { limit: 5, windowMs: 10 * MINUTE },
    perIp: { limit: 30, windowMs: 10 * MINUTE },
  },
  // QA #55: asked once, after Firebase refuses a sign-in to a disabled (banned)
  // account; a person retries a sign-in a few times, a script far more.
  quickLoginRestriction: {
    perDevice: { limit: 10, windowMs: 10 * MINUTE },
    perIp: { limit: 60, windowMs: 10 * MINUTE },
  },
  // B10: "Remove" in the account switcher — by hand, one account at a time,
  // and a device remembers at most five.
  forgetQuickLogin: {
    perDevice: { limit: 10, windowMs: 10 * MINUTE },
    perIp: { limit: 60, windowMs: 10 * MINUTE },
  },
  claimGuestIdentity: {
    perDevice: { limit: 10, windowMs: MINUTE },
    perIp: { limit: 60, windowMs: MINUTE },
  },
  // Security review of the QA fixes (3 Nov 2026): the one SIGNED-IN scope.
  // `checkReferralCode` and `activateHost` share it. Since QA #51 a phone-only
  // caller makes them read up to PHONE_SCAN_LIMIT invitations per call, and the
  // answer still tells a code nobody has from one issued to somebody else — so
  // a script with one account could walk codes at a few hundred reads a guess.
  // The key is the ACCOUNT (passed as the device key: an account is the thing
  // that cannot rotate here), plus the address. A person presses "Verify" and
  // then "Continue" a few times; thirty in ten minutes is far above that.
  hostInvitationLookup: {
    perDevice: { limit: 30, windowMs: 10 * MINUTE },
    perIp: { limit: 300, windowMs: 10 * MINUTE },
  },
}

/** A bucket outlives its window by a day, then is litter for the sweep. */
const BUCKET_TTL_AFTER_WINDOW_MS = 24 * 60 * 60 * 1000

export interface WindowDecision {
  allowed: boolean
  /** Calls already made in this window (before this one). */
  count: number
  /** When refused: until the window turns over. 0 when allowed. */
  retryAfterMs: number
}

/** The start of the window `nowMs` falls in. */
export function windowStartOf(nowMs: number, policy: BucketPolicy): number {
  const windowMs = Math.max(1_000, Number(policy.windowMs) || MINUTE)
  return Math.floor(nowMs / windowMs) * windowMs
}

/**
 * Pure: may one more call be made in this window? A missing or malformed
 * count is zero — a first call is never refused, and a corrupted document can
 * only ever err towards allowing.
 */
export function windowDecision(
  storedCount: unknown,
  policy: BucketPolicy,
  nowMs: number,
): WindowDecision {
  const limit = Math.max(1, Number(policy.limit) || 1)
  const windowMs = Math.max(1_000, Number(policy.windowMs) || MINUTE)
  const raw = Number(storedCount)
  const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  if (count < limit) return { allowed: true, count, retryAfterMs: 0 }
  const windowEnd = windowStartOf(nowMs, policy) + windowMs
  return { allowed: false, count, retryAfterMs: Math.max(1, windowEnd - nowMs) }
}

/** Hashed, so the bucket id carries no device id and no address. */
function keyHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)
}

/** The document id for one bucket. Exported for the tests. */
export function bucketId(scope: string, kind: 'dev' | 'ip', value: string, windowStartMs: number): string {
  return `${scope}:${kind}:${keyHash(value)}:${windowStartMs}`
}

/**
 * The address a request came from.
 *
 * Google's front end APPENDS the connecting address to `X-Forwarded-For`
 * (creating the header when the client sent none), so the LAST entry is the
 * one the infrastructure vouches for; anything before it is whatever the
 * client chose to send. `req.ip` is the fallback when there is no header at
 * all (the emulator, tests). Never logged or stored raw — see `bucketId`.
 */
export function clientIpOf(
  req: { headers?: Record<string, unknown>; ip?: string } | null | undefined,
): string {
  const raw = req?.headers?.['x-forwarded-for']
  const header = Array.isArray(raw) ? raw.join(',') : String(raw ?? '')
  const parts = header.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 0) return parts[parts.length - 1]
  return String(req?.ip ?? '').trim()
}

/**
 * Count this call against every budget it falls under, or throw
 * `resource-exhausted` (`RATE_LIMITED`, with `retryAfterMs`).
 *
 * A key that is absent (no device id sent, no address known) has no bucket:
 * it cannot be limited, so it is not. A scope with no entry in
 * RATE_LIMIT_POLICIES is unlimited — adding a scope is a deliberate edit.
 */
export async function enforceRateLimit(
  scope: string,
  keys: { deviceId?: string; ip?: string },
  nowMs: number = Date.now(),
): Promise<void> {
  const policy = RATE_LIMIT_POLICIES[scope]
  if (!policy) return

  const buckets: { ref: admin.firestore.DocumentReference; policy: BucketPolicy; kind: 'dev' | 'ip'; windowStartMs: number }[] = []
  const deviceId = String(keys.deviceId ?? '').trim()
  const ip = String(keys.ip ?? '').trim()
  const col = admin.firestore().collection(RATE_LIMITS)
  if (policy.perDevice && deviceId !== '') {
    const windowStartMs = windowStartOf(nowMs, policy.perDevice)
    buckets.push({ ref: col.doc(bucketId(scope, 'dev', deviceId, windowStartMs)), policy: policy.perDevice, kind: 'dev', windowStartMs })
  }
  if (policy.perIp && ip !== '') {
    const windowStartMs = windowStartOf(nowMs, policy.perIp)
    buckets.push({ ref: col.doc(bucketId(scope, 'ip', ip, windowStartMs)), policy: policy.perIp, kind: 'ip', windowStartMs })
  }
  if (buckets.length === 0) return

  let decisions: WindowDecision[]
  try {
    const snaps = await Promise.all(buckets.map((b) => b.ref.get()))
    decisions = snaps.map((snap, i) =>
      windowDecision(snap.exists ? snap.get('count') : 0, buckets[i].policy, nowMs),
    )
  } catch (err) {
    functions.logger.warn('rate limit unavailable (read), allowed', { scope, err: String(err) })
    return
  }

  const refused = decisions.filter((d) => !d.allowed)
  if (refused.length > 0) {
    const retryAfterMs = Math.max(...refused.map((d) => d.retryAfterMs))
    functions.logger.warn('rate limited', { scope, retryAfterMs })
    throw new functions.https.HttpsError(
      'resource-exhausted',
      'Too many attempts. Please wait a moment and try again.',
      { code: RATE_LIMITED, retryAfterMs },
    )
  }

  try {
    await Promise.all(buckets.map((b) => b.ref.set({
      scope,
      kind: b.kind,
      count: admin.firestore.FieldValue.increment(1),
      windowStartMs: b.windowStartMs,
      expiresAt: admin.firestore.Timestamp.fromMillis(b.windowStartMs + b.policy.windowMs + BUCKET_TTL_AFTER_WINDOW_MS),
    }, { merge: true })))
  } catch (err) {
    functions.logger.warn('rate limit unavailable (write), allowed', { scope, err: String(err) })
  }
}

// ── App Check plumbing (behind ENFORCE_APP_CHECK, default off) ──────────────

/**
 * `ENFORCE_APP_CHECK=true` turns App Check enforcement on for the callables
 * that opt in through `appCheckRuntimeOptions()` and `refuseWithoutAppCheck()`.
 * It is NOT set anywhere today; the default is off.
 *
 * Why a flag and not simply on: enforcement refuses every call that carries
 * no valid App Check token, and no shipped Android build attaches one yet.
 * Turning it on before the app does would sign every user out at the quick
 * sign-in screen. The order is:
 *
 *   1. Android: add the App Check SDK (Play Integrity provider) and attach
 *      tokens to callable requests; ship it; make it the minimum version.
 *   2. Firebase console: register the app with App Check; watch the
 *      "unverified requests" metric fall to zero.
 *   3. functions/.env: `ENFORCE_APP_CHECK=true`; deploy the four callables.
 *      (`runWith` is evaluated at deploy, so the flag needs a deploy to bite;
 *      the handler check below also reads it at runtime, as the second layer.)
 *
 * Rolling back is the same flag set to false and a deploy.
 */
export function enforcingAppCheck(): boolean {
  return String(process.env.ENFORCE_APP_CHECK ?? '').toLowerCase() === 'true'
}

/** `runWith(...)` options for a callable that opts in: enforcement follows the flag. */
export function appCheckRuntimeOptions(): { enforceAppCheck: boolean } {
  return { enforceAppCheck: enforcingAppCheck() }
}

/**
 * Pure: should this call be refused for lacking App Check? `app` is the
 * callable context's verified App Check payload (`context.app`), present only
 * when a valid token came with the request.
 */
export function appCheckRefusal(app: unknown, enforcing: boolean): boolean {
  return enforcing && !app
}

/** Runtime half of the enforcement: refuse when the flag is on and no token came. */
export function refuseWithoutAppCheck(context: { app?: unknown }, operation: string): void {
  if (!appCheckRefusal(context?.app, enforcingAppCheck())) return
  functions.logger.warn('App Check required and missing', { operation })
  throw new functions.https.HttpsError(
    'unauthenticated',
    'This app build cannot be verified. Please update Zipper and try again.',
    { code: APP_CHECK_REQUIRED },
  )
}

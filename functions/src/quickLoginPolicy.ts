/**
 * QUICK LOGIN — the decisions, with no Firestore in them.
 *
 * Quick Login means exactly one thing:
 *
 *     log back into the account that was most recently signed out
 *     from THIS physical device.
 *
 * It is not a persistent login, not a password, not account recovery, and not
 * transferable. Everything in this file exists to keep it that narrow.
 *
 * ── WHAT IT REPLACES ─────────────────────────────────────────────────────────
 *
 * The previous credential was a 400-day bearer secret. It was redeemed by an
 * unauthenticated callable whose signature carried no `context` at all, it
 * recorded a `deviceId` that was never compared with anything, and a successful
 * redemption only stamped `lastUsedAt` — so the same secret worked again, and
 * again, from anywhere. Copied off one handset it authenticated on another, and
 * Block Store's cloud backup was an explicit channel for exactly that copy.
 *
 * ── THE BINDING, AND WHY IT IS A SIGNATURE ───────────────────────────────────
 *
 * A device id cannot be a security boundary: the client chooses it. So the bind
 * is a KEY the client cannot choose and cannot export — an EC P-256 pair
 * generated in the Android Keystore, where the private half never leaves.
 *
 * At mint the public half is registered against the credential. At redemption
 * the server issues a random challenge and the client signs it. Possession of
 * the secret is no longer enough; the holder must also be able to produce a
 * signature only the original device's hardware can make.
 *
 * A secret restored from a backup onto a second handset therefore fails: the
 * backup carries the bytes, not the Keystore key.
 *
 * ── ROTATION ────────────────────────────────────────────────────────────────
 *
 * A redemption consumes the credential and issues its replacement in the same
 * transaction. An old secret is dead the moment it is used once, so a captured
 * one is worth a single race against the real holder rather than a month of
 * quiet access.
 *
 * This module is pure: no `admin`, no `firestore`, no `functions`. That is what
 * lets `test/quickLoginPolicy.test.js` run every branch below without a
 * Firebase app, and it is why the decisions live here rather than inline.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * How long an unused credential stays good. Thirty days, down from four hundred.
 *
 * It is a convenience for returning to an account you just left, so its life
 * should be measured against "I come back to this app" and not against "I never
 * sign in again". The previous 400 was a year of standing authority for a
 * credential nobody could see or revoke from the device.
 */
export const QUICK_LOGIN_TTL_DAYS = 30

/** A challenge is good for two minutes and is consumed on first use. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000

/** Failed redemptions tolerated per binding before a cool-off. */
export const MAX_FAILURES = 5

/** How long the cool-off lasts once the ceiling is hit. */
export const LOCKOUT_MS = 15 * 60 * 1000

/** Minimum raw secret length. Anything shorter was not minted by us. */
export const MIN_SECRET_CHARS = 32

/** An appeal statement has to actually say something, and has to end. */
export const MIN_STATEMENT_CHARS = 20
export const MAX_STATEMENT_CHARS = 2000

/**
 * The credential format this build issues. A record without it is LEGACY — one
 * of the old 400-day unbound secrets — and is refused rather than honoured, see
 * `isLegacy`.
 */
export const CREDENTIAL_VERSION = 2

// ── Types ────────────────────────────────────────────────────────────────────

export type QuickLoginOutcome =
  /** Proceed: mint a session for this account. */
  | 'allow'
  /** The account is suspended. Show the suspension screen; grant NO app access. */
  | 'suspended'
  /** The account is banned. The credential is destroyed. */
  | 'banned'
  /** This handset is barred, whoever holds it. */
  | 'device_banned'
  /** Deleted, or inside the recovery window. Recovery is its own explicit flow. */
  | 'deleted'
  /** Anything that is not a usable credential. Deliberately undifferentiated. */
  | 'refused'
  /** Minted by the previous implementation; cannot prove a device binding. */
  | 'legacy'
  /** Too many failures against this binding. */
  | 'rate_limited'

export interface CredentialRecord {
  uid?: unknown
  version?: unknown
  publicKey?: unknown
  expiresAt?: { toMillis(): number } | null
  revokedAt?: unknown
}

export interface AccountRecord {
  isBanned?: unknown
  isSuspended?: unknown
  isDeleted?: unknown
  accountState?: unknown
  banReason?: unknown
  suspendedUntil?: { toMillis(): number } | null
}

export interface RateRecord {
  failures?: unknown
  lockedUntil?: { toMillis(): number } | null
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Was this record written by the previous implementation?
 *
 * A legacy record has no version and no registered public key, so there is
 * nothing to verify a signature against. It is not upgradeable in place: the
 * device's Keystore key did not exist when it was minted, so no proof of
 * possession can be constructed for it after the fact.
 *
 * The migration is therefore to refuse it, clear it from the device, and let one
 * ordinary sign-in produce a credential that does satisfy the model.
 */
export function isLegacy(record: CredentialRecord | null | undefined): boolean {
  if (!record) return false
  if (Number(record.version ?? 0) >= CREDENTIAL_VERSION) return false
  return true
}

/** Is this rate-limit record currently in cool-off? */
export function isRateLimited(rate: RateRecord | null | undefined, nowMs: number): boolean {
  if (!rate) return false
  const until = rate.lockedUntil?.toMillis?.()
  return typeof until === 'number' && until > nowMs
}

/** The next failure count and whether that trips a cool-off. */
export function nextFailureState(
  rate: RateRecord | null | undefined,
  nowMs: number,
): { failures: number; lockedUntilMs: number | null } {
  const prior = Number(rate?.failures ?? 0)
  const failures = (Number.isFinite(prior) && prior > 0 ? prior : 0) + 1
  return {
    failures,
    lockedUntilMs: failures >= MAX_FAILURES ? nowMs + LOCKOUT_MS : null,
  }
}

/**
 * Is the credential itself usable, before the account is considered?
 *
 * Every refusal here collapses to one outcome on purpose. Telling a caller that
 * a token "expired" rather than "never existed" tells somebody probing tokens
 * which guesses were close.
 */
export function credentialVerdict(
  record: CredentialRecord | null | undefined,
  nowMs: number,
): 'ok' | 'legacy' | 'refused' {
  if (!record) return 'refused'
  if (isLegacy(record)) return 'legacy'
  if (record.revokedAt) return 'refused'
  if (!String(record.uid ?? '')) return 'refused'
  if (!String(record.publicKey ?? '')) return 'refused'
  const expiry = record.expiresAt?.toMillis?.()
  if (typeof expiry === 'number' && expiry <= nowMs) return 'refused'
  return 'ok'
}

/**
 * What the account's state permits.
 *
 * The order matters and is the business rule, not a preference:
 *
 *   device ban  — bars the handset whoever is holding it, so it outranks
 *                 anything about the account
 *   suspended   — checked BEFORE ban (C9, B25): `suspend_user` sets
 *                 `isBanned: true` as well as `isSuspended` and
 *                 `accountState: 'suspended'`, so reading `isBanned` first
 *                 told every suspended person they were banned. It keeps the
 *                 credential, so the person can reach the suspension screen
 *                 and appeal; it grants no application access at all
 *   banned      — keeps the credential too, for the appeal (see
 *                 `destroysCredential`); there is no way back in
 *   deleted     — including the recovery window, because recovery is an
 *                 explicit flow and must not be entered sideways
 *
 * Which moderation state it is follows the backend's `restriction_of`:
 * `accountState` when it names one, then `isSuspended`, then `isBanned`. A
 * ban that left a stale `isSuspended` behind says `accountState: 'banned'`.
 */
export function accountVerdict(
  account: AccountRecord | null | undefined,
  deviceBanned: boolean,
): QuickLoginOutcome {
  if (deviceBanned) return 'device_banned'
  if (!account) return 'refused'
  const state = String(account.accountState ?? '').trim()
  if (state === 'suspended') return 'suspended'
  if (state === 'banned') return 'banned'
  if (account.isSuspended === true) return 'suspended'
  if (account.isBanned === true) return 'banned'
  if (account.isDeleted === true) return 'deleted'
  if (state === 'permanently_deactivated' || state === 'recovery_pending') return 'deleted'
  return 'allow'
}

/**
 * Does a redemption attempt survive every gate?
 *
 * Composed rather than inlined so the ORDER is visible in one place and can be
 * asserted. A caller that rearranged these would, for instance, tell a banned
 * account's holder that their credential had expired — or worse, let a device
 * ban be skipped because the account looked fine.
 */
export function redemptionOutcome(input: {
  rate: RateRecord | null | undefined
  credential: CredentialRecord | null | undefined
  account: AccountRecord | null | undefined
  deviceBanned: boolean
  signatureValid: boolean
  nowMs: number
}): QuickLoginOutcome {
  if (isRateLimited(input.rate, input.nowMs)) return 'rate_limited'

  const cred = credentialVerdict(input.credential, input.nowMs)
  if (cred === 'legacy') return 'legacy'
  if (cred === 'refused') return 'refused'

  // The signature is checked BEFORE the account is read. A caller that cannot
  // prove possession of the device learns nothing about whether the account
  // behind the secret exists, is banned, or is suspended.
  if (!input.signatureValid) return 'refused'

  return accountVerdict(input.account, input.deviceBanned)
}

/**
 * Does this outcome mean the credential should be destroyed?
 *
 * ── ONLY DELETION. AND BAN USED TO BE HERE ──────────────────────────────────
 *
 * Suspension and ban both KEEP the credential now, and the reason is the same
 * for both: it is the only thing left that can prove who is appealing.
 *
 * `set_user_disabled(uid, True)` in `backend/app/db/firebase.py` disables the
 * Firebase login AND revokes its refresh tokens, so a banned person's session is
 * dead within the second. `AppealRepository` on Android was written when that was
 * not true — its own heading still says "a banned person is still signed in,
 * which is what makes this possible at all" — and once the session died, the
 * appeal form it guards died with it. Destroying the quick-login credential as
 * well removed the last identifier the person had.
 *
 * So the credential survives a ban, and `permitsAppeal` is what it buys:
 * `grantsSession` stays false, no custom token is ever minted, and the Firebase
 * login is disabled independently — three locks, none of which this opens.
 *
 * Deletion keeps nothing. Recovery is its own explicit flow with its own proof,
 * and an appeal against a deletion the person themselves asked for is not a
 * thing that exists.
 *
 * ── AND A BAN THAT IS LIFTED SIMPLY WORKS ───────────────────────────────────
 *
 * Nothing is stamped on the credential to mark it appeal-only. The outcome is
 * computed from the account's CURRENT state on every call, so when a reviewer
 * lifts a ban the next redemption returns `allow` and the person is back. A flag
 * written at ban time would have to be unwritten at lift time by something that
 * remembered to, and the thing that forgets is always that.
 */
export function destroysCredential(outcome: QuickLoginOutcome): boolean {
  return outcome === 'deleted'
}

/** Does this outcome mean a session is created and the credential rotated? */
export function grantsSession(outcome: QuickLoginOutcome): boolean {
  return outcome === 'allow'
}

/**
 * Does this outcome let the holder file an appeal, with no session at all?
 *
 * Ban and suspension: yes. These are the two states a human decided about
 * another human, and both are appealable by the moderation model.
 *
 * Everything else: no, and each for its own reason.
 *
 *   device_banned — the handset is barred; the ACCOUNT may be perfectly fine, so
 *                   there is nothing here to appeal. Device bans go through
 *                   support, which is what the message says.
 *   deleted       — recovery is its own flow, with its own proof.
 *   refused /
 *   legacy        — the caller has not proved anything. An appeal endpoint that
 *                   accepted these would be an open intake with a uid attached
 *                   to whatever somebody sent.
 *   rate_limited  — the cool-off applies here too, or it is a way around it.
 */
export function permitsAppeal(outcome: QuickLoginOutcome): boolean {
  return outcome === 'banned' || outcome === 'suspended'
}

/**
 * Does this outcome answer the caller with a payload rather than an error?
 *
 * Ban and suspension are refusals that are not failures: the credential was
 * valid and the device proved itself, and the answer is "here is what has
 * happened to your account, and here is how to appeal it". Throwing would reduce
 * that to a toast.
 *
 * Everything else throws, and tells the caller as little as possible.
 */
export function isReportableState(outcome: QuickLoginOutcome): boolean {
  return outcome === 'banned' || outcome === 'suspended'
}

/**
 * The sentence shown to the person.
 *
 * Account ban and device ban are deliberately different: one travels with the
 * account and the other with the handset, and a person told the wrong one will
 * take the wrong action. Everything else collapses to one neutral sentence so
 * that a failed probe reveals nothing about which account, if any, was behind
 * the secret.
 */
/**
 * Is this statement something a reviewer can act on?
 *
 * Checked on the SERVER as well as on the device. The appeal callable is
 * unauthenticated by necessity, so the client's own length check is a courtesy
 * to the person typing and not a control on what arrives.
 */
export function statementProblem(statement: string): string {
  const text = String(statement ?? '').trim()
  if (text.length < MIN_STATEMENT_CHARS) {
    return `Tell us what happened, in at least ${MIN_STATEMENT_CHARS} characters. ` +
      'This is what a person reads when they look at your account.'
  }
  if (text.length > MAX_STATEMENT_CHARS) {
    return `Please keep it under ${MAX_STATEMENT_CHARS} characters.`
  }
  return ''
}

export function messageFor(outcome: QuickLoginOutcome, banReason = ''): string {
  switch (outcome) {
    case 'banned':
      return banReason.trim()
        ? banReason.trim()
        : 'Your account has been banned. Please contact support to appeal this decision.'
    case 'device_banned':
      return 'Your device is banned. Contact the support for removing ban.'
    case 'rate_limited':
      return 'Too many attempts. Try again later, or sign in normally.'
    case 'legacy':
      return 'Please sign in once to re-enable quick sign-in on this device.'
    default:
      return 'This quick sign-in is no longer valid. Please sign in.'
  }
}

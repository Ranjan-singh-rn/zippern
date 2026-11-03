/**
 * Binding an EMAIL to the signed-in account by a one-time code (UGP-C).
 *
 * ── THE FLOW ────────────────────────────────────────────────────────────────
 *
 *   app: enter address → `requestEmailBindCode` → a 6-digit code is mailed
 *   app: enter code    → `verifyEmailBindCode`  → the server checks the code,
 *        binds the address to the CALLER'S OWN uid through `bindContactCore`
 *        (the same rules as phone binding) and marks it verified on the
 *        Firebase Auth record → success → Settings.
 *
 * It replaces the Firebase passwordless email LINK, which needed the person to
 * leave the app, tap a mailed https link and be routed back in by an App Link —
 * and which could be spent by whichever account happened to be signed in when
 * the link came back. A code is typed into the account that asked for it.
 *
 * ── WHAT IS GUARANTEED ──────────────────────────────────────────────────────
 *
 *   * The uid never changes. Nothing is merged, transferred or signed into:
 *     the address is attached to the caller or refused.
 *   * A contact already on the account is never replaced, a live (or still
 *     recoverable) holder refuses the bind, and only a permanently deactivated
 *     holder is released — `bindContactCore`, shared with `bindVerifiedIdentity`.
 *   * An address held by ANOTHER Firebase Auth account (a CRM login, a Google
 *     account) is refused as well, before anything is written.
 *   * An email already on the caller's OWN Firebase Auth record (a partner's
 *     CRM sign-in address, a Google account's address) is never replaced
 *     either: the Auth record is checked as well as the document, because a
 *     partner login carries its address on Auth only.
 *   * The code is stored only as a salted HMAC; it expires after 10 minutes,
 *     allows 5 wrong attempts, is single use, and a new request voids the old
 *     one. Sending is limited per account (60 s apart, 5 an hour, 10 a day) and
 *     per address (5 an hour, 10 a day, across all accounts), so this cannot be
 *     used to flood somebody's inbox. For the limits only, an address is folded
 *     (+tags dropped; Gmail dots dropped) so one inbox is one budget.
 *   * Wrong codes are also counted across requests: 10 in a day for an
 *     account, or 30 in a day for an address (whoever asked), stop both
 *     sending and verifying for the rest of the day — asking for a fresh code
 *     does not buy fresh guesses.
 *   * A verify that is retried after a lost response (same code, within 15
 *     minutes of its first use) re-runs the bind, which is idempotent, instead
 *     of answering "code already used" to a person whose bind may have
 *     succeeded.
 *   * Requesting a code never reveals whether an address belongs to anybody:
 *     holders are checked only after the code proves the mailbox is theirs.
 *
 * Both callables need an active session (`assertActiveSession`): a restricted
 * account cannot use this to send mail.
 *
 * Events go to `authEvents` (the existing Functions-side audit collection) and
 * never carry the address — only its domain — or the code.
 */
import * as functions from 'firebase-functions/v1'
import * as admin from 'firebase-admin'
import * as crypto from 'crypto'
import { assertActiveSession } from './mobileSession'
import { bindContactCore, emailKey, isInternalCrmRole, isObserverEmail, sameUidSessionToken, type EmailChangeRescueFacts } from './identity'
import { recordEvent } from './quickLogin'
import { SENDGRID_KEY_ENV, mailDomain, sendTransactionalMail } from './mail'
import { recordEmailProof } from './contactProof'

export const EMAIL_OTP_CHALLENGES = 'emailOtpChallenges'
export const EMAIL_OTP_RATE = 'emailOtpRate'

export const OTP_POLICY = Object.freeze({
  digits: 6,
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
  windowMs: 60 * 60 * 1000,
  maxSendsPerAccountPerWindow: 5,
  maxSendsPerAddressPerWindow: 5,
  dayMs: 24 * 60 * 60 * 1000,
  maxSendsPerAccountPerDay: 10,
  maxSendsPerAddressPerDay: 10,
  /** Wrong codes per ACCOUNT in a day, across all its requests. */
  maxFailuresPerDay: 10,
  /**
   * Wrong codes per ADDRESS in a day, across all accounts. Higher than the
   * account's on purpose (UGP review): this counter is fed by whoever asks for
   * a code to the address, so at 10 a stranger could lock the owner out of
   * their own address with two codes. At 30 it bounds guessing from many
   * throwaway accounts (≤ 30 a day) and costs a griefer six codes, more than
   * exhausting the address's send cap already would.
   */
  maxFailuresPerAddressPerDay: 30,
  replayWindowMs: 15 * 60 * 1000,
  /** `expireAt` on every record, for a Firestore TTL policy (see the report). */
  recordTtlMs: 2 * 24 * 60 * 60 * 1000,
})

function db(): admin.firestore.Firestore {
  return admin.firestore()
}

// ── Pure policy (unit-tested) ────────────────────────────────────────────────

/** A plausible, normalised address, or '' — deliberately simple, not RFC 5322. */
export function validEmail(raw: unknown): string {
  const e = emailKey(raw)
  if (e.length < 3 || e.length > 254) return ''
  if (/\s/.test(e)) return ''
  const at = e.indexOf('@')
  if (at <= 0 || at !== e.lastIndexOf('@')) return ''
  const domain = e.slice(at + 1)
  if (domain.length < 3 || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return ''
  if (domain.includes('..')) return ''
  return e
}

/** "s****@g****.com" — enough for the person to recognise, too little to harvest. */
export function maskEmail(email: string): string {
  const e = emailKey(email)
  const at = e.indexOf('@')
  if (at <= 0) return ''
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  const dot = domain.lastIndexOf('.')
  const host = dot > 0 ? domain.slice(0, dot) : domain
  const tld = dot > 0 ? domain.slice(dot) : ''
  const hide = (s: string) => (s.length <= 1 ? s : s[0] + '*'.repeat(Math.min(s.length - 1, 6)))
  return `${hide(local)}@${hide(host)}${tld}`
}

export function generateCode(): string {
  return String(crypto.randomInt(0, 10 ** OTP_POLICY.digits)).padStart(OTP_POLICY.digits, '0')
}

export function newSalt(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function digestCode(code: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(String(code)).digest('hex')
}

export function codeMatches(code: string, salt: string, digest: string): boolean {
  const a = Buffer.from(digestCode(code, salt), 'hex')
  const b = Buffer.from(String(digest ?? ''), 'hex')
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b)
}

export interface Window { windowStartMs?: number; count?: number }

/** The window after one more send (or one more failure, with `windowMs` a day). */
export function nextWindow(
  w: Window | undefined, nowMs: number, windowMs: number = OTP_POLICY.windowMs,
): Required<Window> {
  const start = Number(w?.windowStartMs ?? 0)
  if (!start || nowMs - start >= windowMs) return { windowStartMs: nowMs, count: 1 }
  return { windowStartMs: start, count: Number(w?.count ?? 0) + 1 }
}

/** How long until a window that has reached `max` reopens; 0 = not full. */
function windowFull(
  w: Window | undefined, nowMs: number, max: number, windowMs: number = OTP_POLICY.windowMs,
): number {
  const start = Number(w?.windowStartMs ?? 0)
  if (!start || nowMs - start >= windowMs) return 0
  return Number(w?.count ?? 0) >= max ? start + windowMs - nowMs : 0
}

/** The cumulative wrong-code lock-out: ms left, or 0. */
export function lockedOutFor(p: { nowMs: number; accountFailures?: Window; addressFailures?: Window }): number {
  return Math.max(
    windowFull(p.accountFailures, p.nowMs, OTP_POLICY.maxFailuresPerDay, OTP_POLICY.dayMs),
    windowFull(p.addressFailures, p.nowMs, OTP_POLICY.maxFailuresPerAddressPerDay, OTP_POLICY.dayMs),
  )
}

/**
 * The address as the RATE LIMITS see it — never what is bound or mailed.
 * `+tag` is dropped for every domain and, for Gmail, the dots too, so one inbox
 * cannot be multiplied into many budgets (`victim+1@…`, `v.ictim@gmail.com`).
 */
export function rateAddress(email: string): string {
  const e = emailKey(email)
  const at = e.lastIndexOf('@')
  if (at <= 0) return e
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

export interface Challenge {
  emailKey?: string
  digest?: string
  salt?: string
  sentAtMs?: number
  expiresAtMs?: number
  attempts?: number
  consumedAtMs?: number
  voided?: boolean
  /**
   * Decision 15 (RC): what the code is FOR. `bind` (absent on challenges
   * written before this field) adds an address to an app account;
   * `login_email` confirms a CRM partner login's OWN address. A code issued
   * for one is never accepted by the other.
   */
  purpose?: 'bind' | 'login_email'
}

export type SendDecision =
  | { ok: true }
  | { ok: false; reason: 'cooldown' | 'rate_limited' | 'locked_out'; retryAfterMs: number }

export function decideSend(p: {
  nowMs: number
  challenge?: Challenge
  accountWindow?: Window
  addressWindow?: Window
  accountDay?: Window
  addressDay?: Window
  accountFailures?: Window
  addressFailures?: Window
}): SendDecision {
  const locked = lockedOutFor(p)
  if (locked > 0) return { ok: false, reason: 'locked_out', retryAfterMs: locked }
  const sentAt = Number(p.challenge?.sentAtMs ?? 0)
  if (sentAt && p.nowMs - sentAt < OTP_POLICY.resendCooldownMs) {
    return { ok: false, reason: 'cooldown', retryAfterMs: sentAt + OTP_POLICY.resendCooldownMs - p.nowMs }
  }
  const wait = Math.max(
    windowFull(p.accountWindow, p.nowMs, OTP_POLICY.maxSendsPerAccountPerWindow),
    windowFull(p.addressWindow, p.nowMs, OTP_POLICY.maxSendsPerAddressPerWindow),
    windowFull(p.accountDay, p.nowMs, OTP_POLICY.maxSendsPerAccountPerDay, OTP_POLICY.dayMs),
    windowFull(p.addressDay, p.nowMs, OTP_POLICY.maxSendsPerAddressPerDay, OTP_POLICY.dayMs),
  )
  if (wait > 0) return { ok: false, reason: 'rate_limited', retryAfterMs: wait }
  return { ok: true }
}

export type VerifyDecision =
  | { result: 'ok' }
  | { result: 'replay' }
  | { result: 'no_code' }
  | { result: 'used' }
  | { result: 'expired' }
  | { result: 'locked' }
  | { result: 'locked_out'; retryAfterMs: number }
  | { result: 'wrong'; attemptsLeft: number }

export function decideVerify(p: {
  nowMs: number
  challenge?: Challenge
  email: string
  code: string
  accountFailures?: Window
  addressFailures?: Window
}): VerifyDecision {
  const c = p.challenge
  if (!c || c.voided || !c.digest || !c.salt || emailKey(c.emailKey) !== emailKey(p.email)) {
    return { result: 'no_code' }
  }
  const consumed = Number(c.consumedAtMs ?? 0)
  if (consumed) {
    // A retry of the SAME code soon after its first use re-runs the bind.
    if (p.nowMs - consumed <= OTP_POLICY.replayWindowMs && codeMatches(p.code, c.salt, c.digest)) {
      return { result: 'replay' }
    }
    return { result: 'used' }
  }
  // Ten wrong codes in a day — whichever codes they were — and no more guesses
  // are compared at all until the day is over.
  const locked = lockedOutFor(p)
  if (locked > 0) return { result: 'locked_out', retryAfterMs: locked }
  if (p.nowMs > Number(c.expiresAtMs ?? 0)) return { result: 'expired' }
  const attempts = Number(c.attempts ?? 0)
  if (attempts >= OTP_POLICY.maxAttempts) return { result: 'locked' }
  if (!codeMatches(p.code, c.salt, c.digest)) {
    return { result: 'wrong', attemptsLeft: Math.max(0, OTP_POLICY.maxAttempts - attempts - 1) }
  }
  return { result: 'ok' }
}

/** Rate-record ids. Addresses only ever appear hashed, and folded (`rateAddress`). */
function hashed(prefix: string, value: string): string {
  return prefix + crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)
}
function rateRefs(uid: string, email: string) {
  const c = db().collection(EMAIL_OTP_RATE)
  const folded = rateAddress(email)
  return {
    accountHour: c.doc(`u_${uid}`),
    addressHour: c.doc(hashed('a_', folded)),
    accountDay: c.doc(`ud_${uid}`),
    addressDay: c.doc(hashed('ad_', folded)),
    accountFailures: c.doc(`uf_${uid}`),
    addressFailures: c.doc(hashed('af_', folded)),
  }
}
function expireAt(nowMs: number): admin.firestore.Timestamp {
  return admin.firestore.Timestamp.fromMillis(nowMs + OTP_POLICY.recordTtlMs)
}
const asWindow = (s: admin.firestore.DocumentSnapshot): Window | undefined =>
  (s.exists ? (s.data() as Window) : undefined)

function codeMail(code: string, purpose: 'bind' | 'login_email' = 'bind'): { subject: string; html: string; text: string } {
  const minutes = Math.round(OTP_POLICY.ttlMs / 60000)
  const what = purpose === 'login_email'
    ? 'Enter it in the Zipper partner portal to confirm this email address on your login.'
    : 'Enter it in the app to add this email address to your account.'
  const text =
    `Your Zipper code is ${code}.\n\n` +
    `${what} It expires in ${minutes} minutes.\n\n` +
    'Do not share this code with anyone. Zipper staff will never ask you for it.\n\n' +
    'If you did not ask for this, ignore this email. Nothing changes on any account.'
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">' +
    '<p>Your Zipper code is</p>' +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>` +
    `<p>${what} It expires in ${minutes} minutes.</p>` +
    '<p><b>Do not share this code with anyone.</b> Zipper staff will never ask you for it.</p>' +
    '<p style="color:#666">If you did not ask for this, ignore this email. Nothing changes on any account.</p>' +
    '</div>'
  return { subject: `${code} is your Zipper code`, html, text }
}

const REPLACEMENT_REFUSED =
  'This account already has an email address. Changing it needs support — contact us.'
const replacementRefused = () => new functions.https.HttpsError('failed-precondition', REPLACEMENT_REFUSED,
  { reason: 'contact_replacement_refused', code: 'contact_replacement_refused' })

function requireUid(context: functions.https.CallableContext): string {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.')
  return context.auth.uid
}

const ACTIVE_HOLDER =
  'This email is already used by another Zipper account. Sign in to that account instead.'

/**
 * Security review (3 Nov 2026): what `emailChangeRescueRefusal` needs to decide
 * whether this caller may be handed a same-uid sign-in after the email change.
 * Read fresh from the Auth record (its `tokensValidAfterTime` moves when the
 * email changes AND when anything else revokes the account's sessions) and
 * from `crmUsers` (staff, Owners and the Observer always sign in again).
 */
async function rescueFacts(uid: string, token: Record<string, unknown>, boundAtMs: number): Promise<EmailChangeRescueFacts> {
  const rec = await admin.auth().getUser(uid).catch(() => null)
  const revokedAt = Date.parse(String(rec?.tokensValidAfterTime ?? ''))
  const crm = await db().collection('crmUsers').doc(uid).get().catch(() => null)
  return {
    nowMs: Date.now(),
    boundAtMs,
    authTimeSec: Number(token['auth_time'] ?? 0),
    tokensValidAfterMs: Number.isFinite(revokedAt) ? revokedAt : 0,
    // Unknown is treated as internal: no token rather than a guess.
    internal: crm === null ? true : (crm.exists ? isInternalCrmRole(crm.get('role')) : false),
  }
}

// ── Callables ────────────────────────────────────────────────────────────────
// ── Callables ────────────────────────────────────────────────────────────────

export const requestEmailBindCode = functions
  .region('asia-south1')
  .runWith({ secrets: [SENDGRID_KEY_ENV] })
  .https.onCall(async (data: { email?: string }, context) => {
    const uid = requireUid(context)
    const token = (context.auth?.token ?? {}) as Record<string, unknown>
    await assertActiveSession(uid, data, 'requestEmailBindCode', context.auth?.token)

    const email = validEmail(data?.email)
    if (!email) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter a valid email address.',
        { reason: 'invalid_email', code: 'invalid_email' })
    }
    if (isObserverEmail(email)) {
      throw new functions.https.HttpsError('permission-denied', 'That address cannot be used in the app.')
    }

    // The account's OWN state only — nothing about anybody else is read here.
    // Both sides: a partner login carries its address on the Auth record only
    // (the document's copy stays empty until proven), and that address is the
    // CRM sign-in — replacing it would move the login without a word.
    const own = await db().collection('users').doc(uid).get()
    const ownEmail = own.exists ? emailKey(own.get('email')) : ''
    const rec = await admin.auth().getUser(uid).catch(() => null)
    const recEmail = rec ? emailKey(rec.email) : ''
    if ((ownEmail !== '' && ownEmail !== email) || (recEmail !== '' && recEmail !== email)) {
      throw replacementRefused()
    }
    if (ownEmail === email && recEmail === email && rec?.emailVerified === true) {
      // Already done — typically a retry after the verify reply was lost. The
      // caller gets the same-uid token it would have had then: the earlier
      // bind changed the Auth record's email, which expired this session's
      // refresh token whatever its provider (see `sameUidSessionToken`) — but
      // only within minutes of that bind, for the session it expired, and not
      // once anything has revoked the account since (`emailChangeRescueRefusal`).
      const challenge = await db().collection(EMAIL_OTP_CHALLENGES).doc(uid).get().catch(() => null)
      const boundAtMs = Number(challenge?.get('boundAtMs') ?? 0)
      const customToken = await sameUidSessionToken(uid, token,
        { afterEmailChange: true, rescue: await rescueFacts(uid, token, boundAtMs) })
      if (customToken) await recordEvent('EMAIL_BIND_SESSION_RESCUED', { uid, via: 'already_bound' })
      return { status: 'already_bound', email: maskEmail(email), ...(customToken ? { customToken } : {}) }
    }

    const nowMs = Date.now()
    const code = generateCode()
    const salt = newSalt()
    const challengeRef = db().collection(EMAIL_OTP_CHALLENGES).doc(uid)
    const r = rateRefs(uid, email)

    const decision = await db().runTransaction(async (tx) => {
      const ch = await tx.get(challengeRef)
      const ah = await tx.get(r.accountHour)
      const dh = await tx.get(r.addressHour)
      const ad = await tx.get(r.accountDay)
      const dd = await tx.get(r.addressDay)
      const af = await tx.get(r.accountFailures)
      const df = await tx.get(r.addressFailures)
      const d = decideSend({
        nowMs,
        challenge: ch.exists ? (ch.data() as Challenge) : undefined,
        accountWindow: asWindow(ah),
        addressWindow: asWindow(dh),
        accountDay: asWindow(ad),
        addressDay: asWindow(dd),
        accountFailures: asWindow(af),
        addressFailures: asWindow(df),
      })
      if (!d.ok) return d
      const exp = expireAt(nowMs)
      // A new code VOIDS the previous one: there is one challenge per account.
      tx.set(challengeRef, {
        emailKey: email,
        digest: digestCode(code, salt),
        salt,
        sentAtMs: nowMs,
        expiresAtMs: nowMs + OTP_POLICY.ttlMs,
        attempts: 0,
        consumedAtMs: 0,
        boundAtMs: 0,
        voided: false,
        purpose: 'bind',
        expireAt: exp,
      })
      tx.set(r.accountHour, { ...nextWindow(asWindow(ah), nowMs), expireAt: exp })
      tx.set(r.addressHour, { ...nextWindow(asWindow(dh), nowMs), expireAt: exp })
      tx.set(r.accountDay, { ...nextWindow(asWindow(ad), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      tx.set(r.addressDay, { ...nextWindow(asWindow(dd), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      return d
    })

    if (!decision.ok) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      throw new functions.https.HttpsError(
        'resource-exhausted',
        decision.reason === 'cooldown'
          ? `Wait ${seconds} seconds before asking for another code.`
          : decision.reason === 'locked_out'
            ? 'Too many wrong codes today. Try again tomorrow.'
            : 'Too many codes were requested. Try again later.',
        { reason: decision.reason, code: decision.reason, retryAfterSec: seconds },
      )
    }

    try {
      await sendTransactionalMail({ to: email, ...codeMail(code) })
    } catch {
      await challengeRef.set({ voided: true, expiresAtMs: 0 }, { merge: true }).catch(() => undefined)
      await recordEvent('EMAIL_BIND_CODE_NOT_SENT', { uid, emailDomain: mailDomain(email) })
      throw new functions.https.HttpsError(
        'unavailable', 'We could not send the email just now. Try again in a minute.',
        { reason: 'mail_unavailable', code: 'mail_unavailable' },
      )
    }

    await recordEvent('EMAIL_BIND_CODE_SENT', { uid, emailDomain: mailDomain(email) })
    return {
      status: 'sent',
      email: maskEmail(email),
      expiresInSec: Math.round(OTP_POLICY.ttlMs / 1000),
      resendInSec: Math.round(OTP_POLICY.resendCooldownMs / 1000),
    }
  })

export const verifyEmailBindCode = functions
  .region('asia-south1')
  .https.onCall(async (data: { email?: string; code?: string }, context) => {
    const uid = requireUid(context)
    const token = (context.auth?.token ?? {}) as Record<string, unknown>
    await assertActiveSession(uid, data, 'verifyEmailBindCode', context.auth?.token)

    const email = validEmail(data?.email)
    const code = String(data?.code ?? '').replace(/\D/g, '')
    if (!email || code.length !== OTP_POLICY.digits) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter the 6-digit code from the email.',
        { reason: 'invalid_code_format', code: 'invalid_code_format' })
    }

    const nowMs = Date.now()
    const challengeRef = db().collection(EMAIL_OTP_CHALLENGES).doc(uid)
    const r = rateRefs(uid, email)
    // The attempt is counted and the code consumed INSIDE the transaction, and
    // the refusal thrown only after it commits — a throw inside would discard
    // the attempt counter and make the five-try limit decorative. A wrong code
    // also counts against the day's failures for the account and the address,
    // which outlive the challenge: a fresh code resets the five attempts, not these.
    const verdict = await db().runTransaction(async (tx) => {
      const ch = await tx.get(challengeRef)
      const af = await tx.get(r.accountFailures)
      const df = await tx.get(r.addressFailures)
      const raw = ch.exists ? (ch.data() as Challenge) : undefined
      // Decision 15 (RC): a code issued to confirm a CRM login's own address
      // does not bind an address to an app account.
      const challenge = raw && raw.purpose === 'login_email' ? undefined : raw
      const v = decideVerify({
        nowMs, challenge, email, code,
        accountFailures: asWindow(af), addressFailures: asWindow(df),
      })
      if (v.result === 'wrong') {
        const exp = expireAt(nowMs)
        tx.set(challengeRef, { attempts: Number(challenge?.attempts ?? 0) + 1 }, { merge: true })
        tx.set(r.accountFailures, { ...nextWindow(asWindow(af), nowMs, OTP_POLICY.dayMs), expireAt: exp })
        tx.set(r.addressFailures, { ...nextWindow(asWindow(df), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      } else if (v.result === 'ok') {
        tx.set(challengeRef, { consumedAtMs: nowMs }, { merge: true })
      }
      return v
    })

    switch (verdict.result) {
      case 'locked_out':
        throw new functions.https.HttpsError('resource-exhausted',
          'Too many wrong codes today. Try again tomorrow.',
          { reason: 'locked_out', code: 'locked_out',
            retryAfterSec: Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)) })
      case 'no_code':
        throw new functions.https.HttpsError('failed-precondition',
          'Ask for a code for this address first.', { reason: 'no_code', code: 'no_code' })
      case 'used':
        throw new functions.https.HttpsError('failed-precondition',
          'That code has already been used. Ask for a new one.', { reason: 'used', code: 'used' })
      case 'expired':
        throw new functions.https.HttpsError('deadline-exceeded',
          'That code has expired. Ask for a new one.', { reason: 'expired', code: 'expired' })
      case 'locked':
        throw new functions.https.HttpsError('resource-exhausted',
          'Too many wrong codes. Ask for a new one.', { reason: 'locked', code: 'locked' })
      case 'wrong':
        throw new functions.https.HttpsError('invalid-argument',
          verdict.attemptsLeft > 0
            ? `That code is not right. ${verdict.attemptsLeft} ${verdict.attemptsLeft === 1 ? 'try' : 'tries'} left.`
            : 'That code is not right. Ask for a new one.',
          { reason: 'wrong_code', code: 'wrong_code', attemptsLeft: verdict.attemptsLeft })
      default:
        break // 'ok' | 'replay'
    }

    // ── The mailbox is proven. Now: may THIS account have it? ───────────────
    const emailDomain = mailDomain(email)
    const refuse = async (reason: string, err: functions.https.HttpsError) => {
      await recordEvent('EMAIL_BIND_REFUSED', { uid, emailDomain, reason })
      return err
    }

    // The caller's OWN Auth record first: an address already on it that is not
    // this one (a partner's CRM sign-in) is never replaced — see the request.
    let ownRecord: admin.auth.UserRecord
    try {
      ownRecord = await admin.auth().getUser(uid)
    } catch {
      throw new functions.https.HttpsError('unavailable',
        'Could not finish just now. Enter the same code again to retry.', { reason: 'lookup_failed', code: 'lookup_failed' })
    }
    const ownAuthEmail = emailKey(ownRecord?.email)
    if (ownAuthEmail !== '' && ownAuthEmail !== email) {
      throw await refuse('contact_replacement_refused', replacementRefused())
    }

    // Another Firebase Auth account carrying this address — a CRM login, a
    // Google account — is somebody's account. Refuse before writing anything.
    try {
      const holder = await admin.auth().getUserByEmail(email)
      if (holder && holder.uid !== uid) {
        throw await refuse('auth_holder',
          new functions.https.HttpsError('already-exists', ACTIVE_HOLDER, { reason: 'active_holder', code: 'active_holder' }))
      }
    } catch (err) {
      if (err instanceof functions.https.HttpsError) throw err
      const codeOf = String((err as { code?: unknown })?.code ?? '')
      if (codeOf !== 'auth/user-not-found') {
        throw new functions.https.HttpsError('unavailable',
          'Could not finish just now. Enter the same code again to retry.', { reason: 'lookup_failed', code: 'lookup_failed' })
      }
    }

    const userRef = db().collection('users').doc(uid)
    const before = await userRef.get()
    const emailBefore = before.exists ? emailKey(before.get('email')) : ''

    let bound: { bound: true; releasedFrom: string[] }
    try {
      bound = await bindContactCore(uid, { email }, token)
    } catch (err) {
      const reason = String((err as { details?: { reason?: string } })?.details?.reason ??
        (err as { code?: string })?.code ?? 'refused')
      await recordEvent('EMAIL_BIND_REFUSED', { uid, emailDomain, reason })
      throw err
    }

    // The Auth record is the side every guest check reads (`is_unverified_guest`,
    // `guestRefusal`, the rules' `tokenEmailVerified`). If it cannot be written,
    // the document write is taken back so nothing is left half-bound.
    let changedAtMs = 0
    try {
      await admin.auth().updateUser(uid, { email, emailVerified: true })
      // When the Auth record — and so its `tokensValidAfterTime` — changed.
      changedAtMs = Date.now()
    } catch (err) {
      if (emailBefore === '') {
        // Take the document write back only if the Auth side really does not
        // hold the address: a concurrent retry of the same code may already
        // have finished, and blanking after it would split the two again.
        const now = await admin.auth().getUser(uid).catch(() => null)
        if (!now || emailKey(now.email) !== email) {
          await userRef.set({ email: '' }, { merge: true }).catch(() => undefined)
        }
      }
      if (String((err as { code?: unknown })?.code ?? '') === 'auth/email-already-exists') {
        throw await refuse('auth_holder',
          new functions.https.HttpsError('already-exists', ACTIVE_HOLDER, { reason: 'active_holder', code: 'active_holder' }))
      }
      throw new functions.https.HttpsError('unavailable',
        'Could not finish just now. Enter the same code again to retry.', { reason: 'auth_update_failed', code: 'auth_update_failed' })
    }

    // Decision 15 (RC): the server's own record that OUR code proved this
    // address — what lets it count for a partner role on any account,
    // including one with a password sign-in method. If it cannot be written
    // the person retries with the same code (the replay window re-runs the
    // bind, which is idempotent, and writes it again).
    try {
      await recordEmailProof(uid, email)
    } catch {
      throw new functions.https.HttpsError('unavailable',
        'Could not finish just now. Enter the same code again to retry.', { reason: 'ledger_failed', code: 'ledger_failed' })
    }

    // When an earlier call bound this address (a replay) — read before it is
    // overwritten, for the session rescue below.
    const priorBoundAtMs = Number((await challengeRef.get().catch(() => null))?.get('boundAtMs') ?? 0)
    // A replay (the Auth record already held the address) keeps the time of
    // the bind that changed it; a fresh bind records when it did.
    const boundAtMs = ownAuthEmail === email ? (priorBoundAtMs || changedAtMs) : changedAtMs
    await challengeRef.set({ boundAtMs }, { merge: true }).catch(() => undefined)
    await recordEvent('EMAIL_BOUND', {
      uid, emailDomain, method: 'otp', replay: verdict.result === 'replay',
      releasedCount: bound.releasedFrom.length,
    })

    // The email just written to the Auth record expired this session's refresh
    // token, whatever its provider — so the caller, not only an anonymous one,
    // is handed a same-uid sign-in: gated above by assertActiveSession, and by
    // `emailChangeRescueRefusal` (this session predates the bind, nothing has
    // revoked the account since, not a staff identity). A replay of a bind an
    // earlier call already wrote dates from that bind.
    const customToken = await sameUidSessionToken(uid, token,
      { afterEmailChange: true, rescue: await rescueFacts(uid, token, boundAtMs) })
    if (customToken) await recordEvent('EMAIL_BIND_SESSION_RESCUED', { uid, via: 'bound' })
    return {
      status: 'bound',
      email,
      releasedFrom: bound.releasedFrom,
      ...(customToken ? { customToken } : {}),
    }
  })

// ══════════════════════════════════════════════════════════════════════════════
// Decision 15 (RC) — confirming a CRM partner login's OWN email address
// ══════════════════════════════════════════════════════════════════════════════
//
// A partner role starts only when the login holds BOTH a verified phone and a
// verified email. A CRM-created login is a password account whose address was
// typed by staff, and the credentials or set-password email they were sent
// proves nothing. These two callables are the proof: a 6-digit code mailed to
// the address ALREADY on the caller's own Auth record (no address is accepted
// from the client, so this can neither add nor change one), checked with the
// same challenge, rate limits and lock-outs as the app's bind flow above.
//
// On success the Auth record is marked `emailVerified` and the server ledger
// `contactVerifications/{uid}` records `method: 'email_code'` for that exact
// address. Nothing is written to `users/{uid}`, nothing is merged, and no
// role is started here — the portal then asks the API to check
// (`POST /api/partner-ops/me/verification/check`), which re-reads both
// contacts itself.
//
// Only a partner LOGIN may ask (a `crmUsers` document whose role is agency or
// seller): this sends mail, so it is not open to every account.

const LOGIN_PURPOSE = 'login_email' as const

async function partnerLoginAddress(uid: string): Promise<string> {
  const crm = await db().collection('crmUsers').doc(uid).get().catch(() => null)
  const role = crm && crm.exists ? String(crm.get('role') ?? '') : ''
  if (role !== 'agency' && role !== 'seller') {
    throw new functions.https.HttpsError('permission-denied',
      'Only a partner login can confirm its email address here.', { reason: 'not_partner_login', code: 'not_partner_login' })
  }
  const rec = await admin.auth().getUser(uid).catch(() => null)
  const email = validEmail(rec?.email ?? '')
  if (!email) {
    throw new functions.https.HttpsError('failed-precondition',
      'This login has no email address to confirm. Contact support.', { reason: 'no_login_email', code: 'no_login_email' })
  }
  if (isObserverEmail(email)) {
    throw new functions.https.HttpsError('permission-denied', 'That address cannot be confirmed here.')
  }
  return email
}

export const requestLoginEmailCode = functions
  .region('asia-south1')
  .runWith({ secrets: [SENDGRID_KEY_ENV] })
  .https.onCall(async (_data: unknown, context) => {
    const uid = requireUid(context)
    const email = await partnerLoginAddress(uid)

    const nowMs = Date.now()
    const code = generateCode()
    const salt = newSalt()
    const challengeRef = db().collection(EMAIL_OTP_CHALLENGES).doc(uid)
    const r = rateRefs(uid, email)

    const decision = await db().runTransaction(async (tx) => {
      const ch = await tx.get(challengeRef)
      const ah = await tx.get(r.accountHour)
      const dh = await tx.get(r.addressHour)
      const ad = await tx.get(r.accountDay)
      const dd = await tx.get(r.addressDay)
      const af = await tx.get(r.accountFailures)
      const df = await tx.get(r.addressFailures)
      const d = decideSend({
        nowMs,
        challenge: ch.exists ? (ch.data() as Challenge) : undefined,
        accountWindow: asWindow(ah),
        addressWindow: asWindow(dh),
        accountDay: asWindow(ad),
        addressDay: asWindow(dd),
        accountFailures: asWindow(af),
        addressFailures: asWindow(df),
      })
      if (!d.ok) return d
      const exp = expireAt(nowMs)
      tx.set(challengeRef, {
        emailKey: email,
        digest: digestCode(code, salt),
        salt,
        sentAtMs: nowMs,
        expiresAtMs: nowMs + OTP_POLICY.ttlMs,
        attempts: 0,
        consumedAtMs: 0,
        boundAtMs: 0,
        voided: false,
        purpose: LOGIN_PURPOSE,
        expireAt: exp,
      })
      tx.set(r.accountHour, { ...nextWindow(asWindow(ah), nowMs), expireAt: exp })
      tx.set(r.addressHour, { ...nextWindow(asWindow(dh), nowMs), expireAt: exp })
      tx.set(r.accountDay, { ...nextWindow(asWindow(ad), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      tx.set(r.addressDay, { ...nextWindow(asWindow(dd), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      return d
    })

    if (!decision.ok) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000))
      throw new functions.https.HttpsError(
        'resource-exhausted',
        decision.reason === 'cooldown'
          ? `Wait ${seconds} seconds before asking for another code.`
          : decision.reason === 'locked_out'
            ? 'Too many wrong codes today. Try again tomorrow.'
            : 'Too many codes were requested. Try again later.',
        { reason: decision.reason, code: decision.reason, retryAfterSec: seconds },
      )
    }

    try {
      await sendTransactionalMail({ to: email, ...codeMail(code, LOGIN_PURPOSE) })
    } catch {
      await challengeRef.set({ voided: true, expiresAtMs: 0 }, { merge: true }).catch(() => undefined)
      await recordEvent('LOGIN_EMAIL_CODE_NOT_SENT', { uid, emailDomain: mailDomain(email) })
      throw new functions.https.HttpsError(
        'unavailable', 'We could not send the email just now. Try again in a minute.',
        { reason: 'mail_unavailable', code: 'mail_unavailable' },
      )
    }
    await recordEvent('LOGIN_EMAIL_CODE_SENT', { uid, emailDomain: mailDomain(email) })
    return {
      status: 'sent',
      email: maskEmail(email),
      expiresInSec: Math.round(OTP_POLICY.ttlMs / 1000),
      resendInSec: Math.round(OTP_POLICY.resendCooldownMs / 1000),
    }
  })

export const verifyLoginEmailCode = functions
  .region('asia-south1')
  .https.onCall(async (data: { code?: string }, context) => {
    const uid = requireUid(context)
    const email = await partnerLoginAddress(uid)
    const code = String(data?.code ?? '').replace(/\D/g, '')
    if (code.length !== OTP_POLICY.digits) {
      throw new functions.https.HttpsError('invalid-argument', 'Enter the 6-digit code from the email.',
        { reason: 'invalid_code_format', code: 'invalid_code_format' })
    }

    const nowMs = Date.now()
    const challengeRef = db().collection(EMAIL_OTP_CHALLENGES).doc(uid)
    const r = rateRefs(uid, email)
    // Same discipline as `verifyEmailBindCode`: the attempt is counted and the
    // code consumed inside the transaction, the refusal thrown after it commits.
    const verdict = await db().runTransaction(async (tx) => {
      const ch = await tx.get(challengeRef)
      const af = await tx.get(r.accountFailures)
      const df = await tx.get(r.addressFailures)
      const raw = ch.exists ? (ch.data() as Challenge) : undefined
      // Only a code issued for THIS purpose: a bind code is not a login proof.
      const challenge = raw && raw.purpose === LOGIN_PURPOSE ? raw : undefined
      const v = decideVerify({
        nowMs, challenge, email, code,
        accountFailures: asWindow(af), addressFailures: asWindow(df),
      })
      if (v.result === 'wrong') {
        const exp = expireAt(nowMs)
        tx.set(challengeRef, { attempts: Number(challenge?.attempts ?? 0) + 1 }, { merge: true })
        tx.set(r.accountFailures, { ...nextWindow(asWindow(af), nowMs, OTP_POLICY.dayMs), expireAt: exp })
        tx.set(r.addressFailures, { ...nextWindow(asWindow(df), nowMs, OTP_POLICY.dayMs), expireAt: exp })
      } else if (v.result === 'ok') {
        tx.set(challengeRef, { consumedAtMs: nowMs }, { merge: true })
      }
      return v
    })

    switch (verdict.result) {
      case 'locked_out':
        throw new functions.https.HttpsError('resource-exhausted',
          'Too many wrong codes today. Try again tomorrow.',
          { reason: 'locked_out', code: 'locked_out',
            retryAfterSec: Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)) })
      case 'no_code':
        throw new functions.https.HttpsError('failed-precondition',
          'Ask for a code first.', { reason: 'no_code', code: 'no_code' })
      case 'used':
        throw new functions.https.HttpsError('failed-precondition',
          'That code has already been used. Ask for a new one.', { reason: 'used', code: 'used' })
      case 'expired':
        throw new functions.https.HttpsError('deadline-exceeded',
          'That code has expired. Ask for a new one.', { reason: 'expired', code: 'expired' })
      case 'locked':
        throw new functions.https.HttpsError('resource-exhausted',
          'Too many wrong codes. Ask for a new one.', { reason: 'locked', code: 'locked' })
      case 'wrong':
        throw new functions.https.HttpsError('invalid-argument',
          verdict.attemptsLeft > 0
            ? `That code is not right. ${verdict.attemptsLeft} ${verdict.attemptsLeft === 1 ? 'try' : 'tries'} left.`
            : 'That code is not right. Ask for a new one.',
          { reason: 'wrong_code', code: 'wrong_code', attemptsLeft: verdict.attemptsLeft })
      default:
        break // 'ok' | 'replay'
    }

    // The mailbox is proven, for the address already on this login. Mark it on
    // the Auth record (the side every reader checks) and in the ledger (what
    // makes it count on a password account). Both are idempotent, so a retry
    // with the same code inside the replay window simply re-runs them.
    try {
      await admin.auth().updateUser(uid, { emailVerified: true })
      await recordEmailProof(uid, email)
    } catch {
      throw new functions.https.HttpsError('unavailable',
        'Could not finish just now. Enter the same code again to retry.', { reason: 'update_failed', code: 'update_failed' })
    }
    await challengeRef.set({ boundAtMs: nowMs }, { merge: true }).catch(() => undefined)
    await recordEvent('LOGIN_EMAIL_VERIFIED', {
      uid, emailDomain: mailDomain(email), replay: verdict.result === 'replay',
    })
    return { status: 'verified', email: maskEmail(email) }
  })

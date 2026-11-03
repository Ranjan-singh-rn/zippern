/**
 * Mail from Functions — the one SendGrid setup every email sent from here uses.
 *
 * Two callers, two contracts (both unchanged from before this module existed):
 *
 *   * `sendTransactionalMail` — the one-time codes (emailOtp.ts). The reader is
 *     waiting for it, so a missing key or a refused send THROWS `MailUnavailable`
 *     and the caller can say "we could not send the code" instead of "check your
 *     inbox" for a message that never left.
 *   * `sendNotificationMail` — the registration, approval and report emails
 *     (index.ts `sendMail`). No key: logged and skipped. A refused send throws
 *     (`MailSendError`), and every caller catches and logs it.
 *
 * The key is the Secret Manager secret ZIPPER_SENDGRID_API_KEY. It reaches
 * `process.env` only in functions that declare it in `runWith({ secrets })`.
 * It is never logged, and no error that leaves this module carries it: for a
 * network failure the SDK rejects with the HTTP library's own error, which holds
 * the whole request configuration INCLUDING the Authorization header, so that
 * object is replaced here by a `MailSendError` that carries a code and nothing
 * else.
 *
 * Only the recipient's DOMAIN is ever logged — never the address, the subject or
 * the body. A code email carries the code in both its subject and its body.
 *
 * Retries, and why so few: a request is sent again only when SendGrid
 * demonstrably did not accept it — the connection could not be made, or it
 * answered 429 or 503. A timeout, a connection dropped after the request went
 * out, or a 500/502/504 may mean the message WAS accepted, so those are never
 * retried: a missing email can be asked for again, a duplicate cannot be taken
 * back. At most 3 attempts, 10 s each, 25 s in all.
 *
 * Click, open, subscription and Google Analytics tracking are switched off on
 * every message, whatever the SendGrid account defaults are. Every email sent
 * from here is a sign-in code, a sign-in or onboarding notice, or an internal
 * report; none of them needs tracking, and an unsubscribe link on a code email
 * would let one click stop every future code to that address.
 *
 * Sender identities — spec §12, the same table as backend/app/services/email.py:
 *
 *     auth | security | transactional  →  no-reply@   always
 *     info                             →  info@       only if EMAIL_IDENTITY_INFO_ENABLED
 *     support                          →  support@    only if EMAIL_IDENTITY_SUPPORT_ENABLED
 *
 * Both switches default to false (owner question Q8: info@ and support@ are not
 * confirmed mailboxes), and an identity whose switch is off leaves from no-reply@.
 * Every send names its identity. No Reply-To is ever set — SENDGRID_REPLY_TO is
 * read only as the support@ address once that switch is on.
 *
 * The transport is replaceable so the callables can run in tests without a
 * network, and the SendGrid endpoint can be pointed at a local test server.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as functions from 'firebase-functions/v1'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MailService } = require('@sendgrid/mail')

/** Spec §12 sender identities (the backend's `SenderIdentity`, minus its legacy `bulk`). */
export type MailIdentity = 'auth' | 'security' | 'transactional' | 'info' | 'support'

export interface MailMessage {
  to: string
  subject: string
  html: string
  /** Plain-text part. Empty: derived from `html`. */
  text: string
  /** Which §12 identity this leaves under. Absent: `transactional`. */
  identity?: MailIdentity
}

/** What a transport may report back; `undefined` is read as one attempt. */
export interface MailSendInfo {
  attempts: number
}

export type MailTransport = (message: MailMessage) => Promise<MailSendInfo | void>

/** The Secret Manager secret that holds the SendGrid API key. */
export const SENDGRID_KEY_ENV = 'ZIPPER_SENDGRID_API_KEY'

const DEFAULT_FROM_EMAIL = 'no-reply@zipperlive.org'
const DEFAULT_FROM_NAME = 'ZIPPER Live'

/*
 * QA #47 (3 Nov 2026) — the official domain and its three addresses (Owner
 * decision, final): no-reply@ SENDS every automated message (above); info@
 * and support@ are CONTACTS a person is told to write to, and nothing
 * automated is sent from them (their identity switches stay off). The same
 * three live in `backend/app/core/contacts.py`, `zipper-crm/lib/contacts.ts`
 * and the app's `ZipperContacts`; `backend/tests/test_qa_email_identities.py`
 * checks they agree. Partner emails from here used to say "Reach us at" a
 * personal Gmail address.
 */
export const OFFICIAL_EMAIL_DOMAIN = 'zipperlive.org'
export const SUPPORT_EMAIL = `support@${OFFICIAL_EMAIL_DOMAIN}`
export const INFO_EMAIL = `info@${OFFICIAL_EMAIL_DOMAIN}`

/** An override honoured only on the official domain — a typo cannot publish a stranger's mailbox. */
function officialContact(override: string | undefined, fallback: string): string {
  const v = String(override ?? '').trim().toLowerCase()
  const at = v.lastIndexOf('@')
  if (!v || at <= 0 || /\s/.test(v) || v.slice(at + 1) !== OFFICIAL_EMAIL_DOMAIN) return fallback
  if (v === DEFAULT_FROM_EMAIL) return fallback // a sender is not a contact
  return v
}

/** Where an email tells a person to write for help (CONTACT_SUPPORT_EMAIL may override, on the domain). */
export function supportContact(): string {
  return officialContact(process.env.CONTACT_SUPPORT_EMAIL, SUPPORT_EMAIL)
}

/** The default sender. `SENDGRID_FROM_EMAIL` / `SENDGRID_FROM_NAME` override it. */
export const MAIL_FROM = Object.freeze({ email: DEFAULT_FROM_EMAIL, name: DEFAULT_FROM_NAME })

/** The mail could not be handed to the provider. Safe to show as "try again". */
export class MailUnavailable extends Error {}

/**
 * A send that failed, reduced to what is safe to log: a code (the HTTP status,
 * or the network error code), how many attempts were made, and whether the
 * message may nevertheless have been accepted. Never the SDK's error object.
 */
export class MailSendError extends Error {
  readonly code: string
  readonly statusCode: number | null
  readonly attempts: number
  readonly outcomeUnknown: boolean

  constructor(code: string, statusCode: number | null, attempts: number, outcomeUnknown: boolean, detail = '') {
    super(
      `email not sent (${code}, ${attempts} attempt${attempts === 1 ? '' : 's'})` +
        (outcomeUnknown ? ' — SendGrid may have accepted it, so it was not sent again' : '') +
        (detail ? `: ${detail}` : ''),
    )
    this.name = 'MailSendError'
    this.code = code
    this.statusCode = statusCode
    this.attempts = attempts
    this.outcomeUnknown = outcomeUnknown
  }
}

export function mailDomain(to: string): string {
  return String(to ?? '').split('@')[1] ?? ''
}

/** HTML-escape a value before it goes into an email body (applicant-supplied names, addresses). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A plain-text alternative for an HTML-only email. Links keep their target. */
export function textFromHtml(html: string): string {
  const decode = (s: string): string =>
    s
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&')
  const text = String(html ?? '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, '').trim()
      return l && l !== href ? `${l} (${href})` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '  ')
    .replace(/<[^>]+>/g, '')
  return decode(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── The provider ────────────────────────────────────────────────────────────

/** 10 s per attempt, 25 s in all, at most 3 attempts, never a new one with < 5 s left; waits 1 s, then 2 s. */
const LIMITS = Object.freeze({ timeoutMs: 10_000, budgetMs: 25_000, maxAttempts: 3, minRemainingMs: 5_000, baseDelayMs: 1_000 })
let limits: { timeoutMs: number; budgetMs: number; maxAttempts: number; minRemainingMs: number; baseDelayMs: number } = { ...LIMITS }

/** No connection was made, so SendGrid cannot have seen the request. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])

type Verdict = 'retry' | 'unknown' | 'permanent'

interface Classified {
  verdict: Verdict
  code: string
  status: number | null
  retryAfterMs: number | null
  detail: string
}

// Replaceable in tests only.
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
let clock = (): number => Date.now()
let jitter = (): number => Math.random() * 0.25

function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return ''
  const h = headers as { get?: (k: string) => unknown } & Record<string, unknown>
  const v = typeof h.get === 'function' ? h.get(name) : h[name] ?? h[name.toLowerCase()]
  return v === undefined || v === null ? '' : String(v)
}

function retryAfterMs(headers: unknown): number | null {
  const ra = headerValue(headers, 'retry-after')
  if (ra && /^\d+$/.test(ra.trim())) return Number(ra.trim()) * 1000
  const reset = headerValue(headers, 'x-ratelimit-reset')
  if (reset && /^\d+$/.test(reset.trim())) return Math.max(0, Number(reset.trim()) * 1000 - clock())
  return null
}

/** SendGrid's own words for a refusal, without anything that looks like an address. */
function providerDetail(body: unknown): string {
  const errors = (body as { errors?: Array<{ message?: unknown; field?: unknown }> } | null)?.errors
  if (!Array.isArray(errors)) return ''
  return errors
    .slice(0, 3)
    .map((e) => [e?.field, e?.message].filter((x) => typeof x === 'string' && x).join(': '))
    .filter(Boolean)
    .join('; ')
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, '***@***')
    .slice(0, 300)
}

function classify(err: unknown): Classified {
  const e = err as {
    code?: unknown
    response?: { headers?: unknown; body?: unknown }
    isAxiosError?: unknown
    config?: unknown
  } | null
  if (typeof e?.code === 'number') {
    // SendGrid answered: @sendgrid/client's ResponseError, code = HTTP status.
    const status = e.code
    const detail = providerDetail(e.response?.body)
    if (status === 429 || status === 503) {
      return { verdict: 'retry', code: String(status), status, retryAfterMs: retryAfterMs(e.response?.headers), detail }
    }
    if (status >= 500) return { verdict: 'unknown', code: String(status), status, retryAfterMs: null, detail }
    return { verdict: 'permanent', code: String(status), status, retryAfterMs: null, detail }
  }
  const code = typeof e?.code === 'string' ? e.code : ''
  if (code && NOT_SENT_CODES.has(code)) return { verdict: 'retry', code, status: null, retryAfterMs: null, detail: '' }
  if (e && (e.isAxiosError || e.config || code)) {
    // The request may have gone out: a timeout, a reset, a cancelled socket.
    return { verdict: 'unknown', code: code || 'network_error', status: null, retryAfterMs: null, detail: '' }
  }
  // Thrown before any request was made (e.g. the SDK refusing a malformed message).
  return { verdict: 'permanent', code: 'invalid_message', status: null, retryAfterMs: null, detail: '' }
}

function providerProblem(): string | null {
  const provider = String(process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase() || 'sendgrid'
  return provider === 'sendgrid' ? null : 'unsupported_provider'
}

/**
 * identity → its stream and the environment switch that turns it on (`null`:
 * always on). The env names are the backend settings' names, upper-cased, so one
 * value in the deployment configuration means the same thing on both sides.
 */
export const IDENTITY_TABLE: Readonly<Record<MailIdentity, { stream: 'no-reply' | 'info' | 'support'; switchEnv: string | null }>> =
  Object.freeze({
    auth: { stream: 'no-reply', switchEnv: null },
    security: { stream: 'no-reply', switchEnv: null },
    transactional: { stream: 'no-reply', switchEnv: null },
    info: { stream: 'info', switchEnv: 'EMAIL_IDENTITY_INFO_ENABLED' },
    support: { stream: 'support', switchEnv: 'EMAIL_IDENTITY_SUPPORT_ENABLED' },
  })

/** pydantic's reading of a boolean env value, so both sides agree on "on". */
function switchOn(name: string | null): boolean {
  if (!name) return false
  return ['1', 'true', 'yes', 'on', 'y', 't'].includes(String(process.env[name] ?? '').trim().toLowerCase())
}

function domainOf(address: string): string {
  return String(address ?? '').trim().toLowerCase().split('@')[1] ?? ''
}

/** Everything about how one identity leaves. No secret in it. */
export function identityResolution(identity: MailIdentity = 'transactional'): {
  identity: MailIdentity
  stream: string
  switchEnv: string | null
  enabled: boolean
  from: { email: string; name: string }
  replyTo: ''
  tracking: 'off'
} {
  const key: MailIdentity = identity in IDENTITY_TABLE ? identity : 'transactional'
  const row = IDENTITY_TABLE[key]
  const enabled = row.switchEnv === null || switchOn(row.switchEnv)
  const noReply = {
    email: String(process.env.SENDGRID_FROM_EMAIL ?? '').trim() || DEFAULT_FROM_EMAIL,
    name: String(process.env.SENDGRID_FROM_NAME ?? '').trim() || DEFAULT_FROM_NAME,
  }
  let from = noReply
  if (enabled && row.stream === 'info') {
    from = {
      email: String(process.env.MAIL_FROM_INFO ?? '').trim() || `info@${domainOf(noReply.email)}`,
      name: noReply.name,
    }
  } else if (enabled && row.stream === 'support') {
    from = {
      email:
        String(process.env.MAIL_FROM_SUPPORT ?? '').trim() ||
        String(process.env.SENDGRID_REPLY_TO ?? '').trim() ||
        `support@${domainOf(noReply.email)}`,
      name: noReply.name,
    }
  }
  // No Reply-To, on any identity (§12). Tracking: off for everything sent from
  // here — auth and security by the spec, the rest because none of it needs it.
  return { identity: key, stream: row.stream, switchEnv: row.switchEnv, enabled, from, replyTo: '', tracking: 'off' }
}

const service = new MailService()
/** Tests only: a local stand-in for SendGrid. Null in production. */
let testBaseUrl: string | null = null

const sendGrid: MailTransport = async (m) => {
  const apiKey = String(process.env[SENDGRID_KEY_ENV] ?? '').trim()
  if (!apiKey || providerProblem()) throw new MailUnavailable('mail is not configured')
  // `setApiKey` also resets the endpoint to SendGrid's global one.
  service.setApiKey(apiKey)
  if (testBaseUrl) service.client.setDefaultRequest('baseUrl', testBaseUrl)

  const who = identityResolution(m.identity ?? 'transactional')
  const message: Record<string, unknown> = {
    to: m.to,
    from: who.from,
    subject: m.subject,
    html: m.html,
    text: m.text || textFromHtml(m.html),
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
      ganalytics: { enable: false },
    },
  }
  // Deliberately no Reply-To (spec §12): a reply goes to the From address.

  const started = clock()
  let attempts = 0
  for (;;) {
    const remaining = limits.budgetMs - (clock() - started)
    service.setTimeout(Math.max(1, Math.min(limits.timeoutMs, remaining)))
    attempts += 1
    let failure: Classified
    try {
      await service.send(message)
      return { attempts }
    } catch (err) {
      failure = classify(err)
    }
    if (failure.verdict !== 'retry' || attempts >= limits.maxAttempts) {
      throw new MailSendError(failure.code, failure.status, attempts, failure.verdict === 'unknown', failure.detail)
    }
    const backoff = limits.baseDelayMs * 2 ** (attempts - 1) * (1 + jitter())
    const wait = Math.max(backoff, failure.retryAfterMs ?? 0)
    const left = limits.budgetMs - (clock() - started) - wait
    if (left < limits.minRemainingMs) {
      throw new MailSendError(failure.code, failure.status, attempts, false, failure.detail)
    }
    await sleep(wait)
  }
}

let transport: MailTransport = sendGrid

/** Tests only: route mail somewhere observable. `null` restores SendGrid. */
export function setMailTransportForTests(next: MailTransport | null): void {
  transport = next ?? sendGrid
}

// ── Local test copy: a mailbox on disk instead of a provider ─────────────────
//
// LOCAL TEST COPY ONLY. ~/zipper-release/qa/local-stack.command sets
// LOCAL_MAILBOX_DIR for the Functions emulator; there, a message that would
// have gone out is written to that folder as one JSON file instead, so the
// local copy can finish the flows that wait for an emailed code (adding an
// email to an app account, the email sign-in code). The backend does the same
// (`email._local_mailbox_dir`). Never in production: the folder is used only
// inside the Functions emulator (FUNCTIONS_EMULATOR=true) running a `demo-`
// project; anywhere else this returns null and nothing below is reached.

/** The local mailbox folder, or null — always null outside the emulator and a `demo-` project. */
export function localMailboxDir(): string | null {
  if (String(process.env.FUNCTIONS_EMULATOR ?? '') !== 'true') return null
  const project = String(process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? '').trim()
  if (!project.startsWith('demo-')) return null
  const dir = String(process.env.LOCAL_MAILBOX_DIR ?? '').trim()
  return dir || null
}

/** Writes one would-be message to [dir] (0600); returns the file name, which carries no address and no code. */
async function writeLocalMailbox(dir: string, m: MailMessage): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[-:.]/g, '')
  const identity = m.identity ?? 'transactional'
  const name = `${stamp}-${crypto.randomBytes(3).toString('hex')}-functions-${identity}.json`
  const body = { to: m.to, identity, subject: m.subject, text: m.text || textFromHtml(m.html), html: m.html }
  await fs.promises.writeFile(path.join(dir, name), JSON.stringify(body, null, 1), { encoding: 'utf8', mode: 0o600 })
  return name
}

/** Tests only: point the real SendGrid transport at another endpoint. `null` restores SendGrid's. */
export function setSendGridBaseUrlForTests(url: string | null): void {
  testBaseUrl = url
}

/** Tests only: replace the waiting, the clock, the jitter or the limits. `null` restores each. */
export function setRetryTimingForTests(t: {
  sleep?: ((ms: number) => Promise<void>) | null
  clock?: (() => number) | null
  jitter?: (() => number) | null
  limits?: Partial<typeof LIMITS> | null
}): void {
  if (t.sleep !== undefined) sleep = t.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  if (t.clock !== undefined) clock = t.clock ?? (() => Date.now())
  if (t.jitter !== undefined) jitter = t.jitter ?? (() => Math.random() * 0.25)
  if (t.limits !== undefined) limits = { ...LIMITS, ...(t.limits ?? {}) }
}

function asSendError(err: unknown): MailSendError {
  if (err instanceof MailSendError) return err
  if (err instanceof MailUnavailable) return new MailSendError('not_configured', null, 0, false)
  const c = classify(err)
  return new MailSendError(c.code, c.status, 1, c.verdict === 'unknown')
}

// ── The two callers ─────────────────────────────────────────────────────────

/** A one-time code — identity `auth` unless the caller names another. Throws `MailUnavailable` when it could not be sent. */
export async function sendTransactionalMail(message: MailMessage): Promise<void> {
  const toDomain = mailDomain(message.to)
  const mailbox = localMailboxDir()
  if (mailbox) {
    try {
      const file = await writeLocalMailbox(mailbox, { ...message, identity: message.identity ?? 'auth' })
      functions.logger.info('transactional mail written to the local mailbox', { toDomain, file })
      return
    } catch {
      functions.logger.error('transactional mail failed', { toDomain, reason: 'local_mailbox', attempts: 0, outcomeUnknown: false })
      throw new MailUnavailable('local mailbox write failed')
    }
  }
  try {
    const info = await transport({ ...message, identity: message.identity ?? 'auth' })
    functions.logger.info('transactional mail sent', { toDomain, attempts: (info && info.attempts) || 1 })
  } catch (err) {
    const notConfigured = err instanceof MailUnavailable
    const failed = notConfigured ? null : asSendError(err)
    functions.logger.error('transactional mail failed', {
      toDomain,
      reason: notConfigured ? 'not_configured' : String((err as { code?: unknown })?.code ?? 'provider_error'),
      attempts: failed ? failed.attempts : 0,
      outcomeUnknown: failed ? failed.outcomeUnknown : false,
    })
    throw notConfigured ? err : new MailUnavailable('send failed')
  }
}

/**
 * A notification (registration, approval, report), under the named §12
 * identity (default `transactional`). No key: logged and skipped, and the
 * result says `not_configured` so a caller keeping a send marker can tell
 * "sent" from "skipped". A failed send throws a `MailSendError` — never the
 * SDK's error, which can hold the API key.
 */
export async function sendNotificationMail(
  to: string,
  subject: string,
  html: string,
  identity: MailIdentity = 'transactional',
): Promise<'sent' | 'not_configured'> {
  const toDomain = mailDomain(to)
  const mailbox = localMailboxDir()
  if (mailbox) {
    try {
      const file = await writeLocalMailbox(mailbox, { to, subject, html, text: '', identity })
      functions.logger.info('notification mail written to the local mailbox', { toDomain, identity, file })
      return 'sent'
    } catch {
      throw new MailSendError('local_mailbox', null, 1, false)
    }
  }
  const hasKey = String(process.env[SENDGRID_KEY_ENV] ?? '').trim() !== ''
  functions.logger.info('sendMail called', { toDomain, hasKey, identity })
  if (!hasKey || providerProblem()) {
    functions.logger.error(
      `${SENDGRID_KEY_ENV} is not available to this function (or EMAIL_PROVIDER is not sendgrid) — email will NOT be sent.`,
      { toDomain },
    )
    return 'not_configured'
  }
  try {
    const info = await transport({ to, subject, html, text: '', identity })
    functions.logger.info('✅ Email sent', { toDomain, identity, attempts: (info && info.attempts) || 1 })
    return 'sent'
  } catch (err) {
    const failed = asSendError(err)
    functions.logger.error('❌ SendGrid error', {
      toDomain,
      code: failed.code,
      attempts: failed.attempts,
      outcomeUnknown: failed.outcomeUnknown,
    })
    throw failed
  }
}

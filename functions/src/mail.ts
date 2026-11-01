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
 * The transport is replaceable so the callables can run in tests without a
 * network, and the SendGrid endpoint can be pointed at a local test server.
 */
import * as functions from 'firebase-functions/v1'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MailService } = require('@sendgrid/mail')

export interface MailMessage {
  to: string
  subject: string
  html: string
  /** Plain-text part. Empty: derived from `html`. */
  text: string
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

function sender(): { from: { email: string; name: string }; replyTo: string } {
  return {
    from: {
      email: String(process.env.SENDGRID_FROM_EMAIL ?? '').trim() || DEFAULT_FROM_EMAIL,
      name: String(process.env.SENDGRID_FROM_NAME ?? '').trim() || DEFAULT_FROM_NAME,
    },
    replyTo: String(process.env.SENDGRID_REPLY_TO ?? '').trim(),
  }
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

  const who = sender()
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
  if (who.replyTo) message.replyTo = who.replyTo

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

/** A one-time code. Throws `MailUnavailable` when it could not be sent. */
export async function sendTransactionalMail(message: MailMessage): Promise<void> {
  const toDomain = mailDomain(message.to)
  try {
    const info = await transport(message)
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
 * A notification (registration, approval, report). No key: logged and skipped.
 * A failed send throws a `MailSendError` — never the SDK's error, which can hold
 * the API key.
 */
export async function sendNotificationMail(to: string, subject: string, html: string): Promise<void> {
  const toDomain = mailDomain(to)
  const hasKey = String(process.env[SENDGRID_KEY_ENV] ?? '').trim() !== ''
  functions.logger.info('sendMail called', { toDomain, hasKey })
  if (!hasKey || providerProblem()) {
    functions.logger.error(
      `${SENDGRID_KEY_ENV} is not available to this function (or EMAIL_PROVIDER is not sendgrid) — email will NOT be sent.`,
      { toDomain },
    )
    return
  }
  try {
    const info = await transport({ to, subject, html, text: '' })
    functions.logger.info('✅ Email sent', { toDomain, attempts: (info && info.attempts) || 1 })
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

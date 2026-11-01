/**
 * SendGrid migration — the REAL transport (@sendgrid/mail → @sendgrid/client →
 * axios), end to end against a local HTTP server standing in for SendGrid.
 *
 * What is pinned:
 *
 *   * the request: From no-reply@zipperlive.org / "ZIPPER Live" (info@ /
 *     support@ only once their §12 switch is on), never a Reply-To, every kind
 *     of tracking switched off,
 *     a plain-text part beside the HTML, the key only in the Authorization
 *     header;
 *   * retries only when SendGrid demonstrably did not accept the request
 *     (connection refused, 429, 503), never after a timeout, a dropped
 *     connection or a 500/502/504 — so nobody is sent the same email twice;
 *   * no error and no log line ever carries the key, the code or the address;
 *   * the two contracts: a code that could not be sent throws `MailUnavailable`,
 *     a notification without a key is logged and skipped;
 *   * a code callable sends through the real transport;
 *   * exactly the nine email functions are given ZIPPER_SENDGRID_API_KEY;
 *   * applicant-supplied names are HTML-escaped in the email bodies.
 *
 * No network beyond 127.0.0.1, no real key (a fake one), no emulator.
 * Run:  node --test test/sendgridMail.test.js
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const http = require('http')
const util = require('util')
const fs = require('fs')
const path = require('path')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()

const FAKE_KEY = 'SG.FAKE-TEST-KEY-sendgridMail-0123456789abcdef'
process.env.ZIPPER_SENDGRID_API_KEY = FAKE_KEY

// ── A scripted Firebase Auth (enough for requestEmailBindCode) ──────────────
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [] }),
    getUserByEmail: async () => { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e },
    updateUser: async () => undefined,
    createCustomToken: async (uid) => `custom-${uid}`,
    revokeRefreshTokens: async () => undefined,
  }),
})

const MAIL = require('../lib/mail')
const OTP = require('../lib/emailOtp')

// ── A local SendGrid ────────────────────────────────────────────────────────
// Each request takes the next step of `script`: { status, body, headers },
// { kind: 'stall' } (read the request, never answer) or { kind: 'reset' }
// (read the request, then drop the connection). An empty script answers 202.
const sg = { requests: [], script: [], server: null, port: 0, sockets: new Set() }

function startServer() {
  return new Promise((resolve) => {
    sg.server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        let body = null
        try { body = JSON.parse(raw) } catch { body = raw }
        sg.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
        const step = sg.script.shift() || { status: 202 }
        if (step.kind === 'stall') return
        if (step.kind === 'reset') { req.socket.destroy(); return }
        res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) })
        res.end(step.body === undefined ? '' : JSON.stringify(step.body))
      })
    })
    sg.server.on('connection', (s) => { sg.sockets.add(s); s.on('close', () => sg.sockets.delete(s)) })
    sg.server.listen(0, '127.0.0.1', () => { sg.port = sg.server.address().port; resolve() })
  })
}

function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
  })
}

// ── Everything written to stdout/stderr while `fn` runs (passed through) ───
async function capture(fn) {
  const chunks = []
  const ow = process.stdout.write, ew = process.stderr.write
  process.stdout.write = function (c, ...a) { chunks.push(String(c)); return ow.call(this, c, ...a) }
  process.stderr.write = function (c, ...a) { chunks.push(String(c)); return ew.call(this, c, ...a) }
  try {
    return { value: await fn(), error: null, logs: chunks.join('') }
  } catch (error) {
    return { value: undefined, error, logs: chunks.join('') }
  } finally {
    process.stdout.write = ow
    process.stderr.write = ew
  }
}

const waits = []
const content = (req, type) => ((req.body && req.body.content) || []).find((c) => c.type === type)?.value ?? ''
const TRACKING_OFF = {
  click_tracking: { enable: false, enable_text: false },
  open_tracking: { enable: false },
  subscription_tracking: { enable: false },
  ganalytics: { enable: false },
}
const codeMail = { to: 'person@example.com', subject: '482913 is your Zipper code',
  html: '<p>Your Zipper code is</p><p style="font-size:28px">482913</p>', text: 'Your Zipper code is 482913.' }

function noLeak(text) {
  expect(text.includes(FAKE_KEY)).toBe(false)
  expect(text.includes('FAKE-TEST-KEY')).toBe(false)
}

before(async () => {
  await startServer()
})
after(() => {
  for (const s of sg.sockets) s.destroy()
  sg.server.close()
})
beforeEach(() => {
  sg.requests = []
  sg.script = []
  waits.length = 0
  process.env.ZIPPER_SENDGRID_API_KEY = FAKE_KEY
  delete process.env.EMAIL_PROVIDER
  delete process.env.SENDGRID_FROM_EMAIL
  delete process.env.SENDGRID_FROM_NAME
  delete process.env.SENDGRID_REPLY_TO
  MAIL.setMailTransportForTests(null)
  MAIL.setSendGridBaseUrlForTests(`http://127.0.0.1:${sg.port}/`)
  MAIL.setRetryTimingForTests({ sleep: async (ms) => { waits.push(ms) }, jitter: () => 0, clock: null, limits: null })
})
afterEach(() => {
  MAIL.setSendGridBaseUrlForTests(null)
  MAIL.setRetryTimingForTests({ sleep: null, jitter: null, clock: null, limits: null })
})

// ══════════════════════════════════════════════════════════════════════════
describe('the request SendGrid receives', () => {
  test('a code email: one request, the new sender, no Reply-To, tracking off, text + html, key only in the header', async () => {
    const r = await capture(() => MAIL.sendTransactionalMail(codeMail))
    expect(r.error).toBe(null)
    expect(sg.requests.length).toBe(1)
    const req = sg.requests[0]
    expect(req.method).toBe('POST')
    expect(req.url).toBe('/v3/mail/send')
    expect(req.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    expect(req.body.from).toEqual({ email: 'no-reply@zipperlive.org', name: 'ZIPPER Live' })
    expect(req.body.reply_to).toBe(undefined)
    expect(req.body.personalizations[0].to[0].email).toBe('person@example.com')
    expect(req.body.tracking_settings).toEqual(TRACKING_OFF)
    expect(content(req, 'text/plain')).toBe('Your Zipper code is 482913.')
    expect(content(req, 'text/html').includes('482913')).toBe(true)
    // the log says it went, to which domain — and nothing else
    expect(r.logs.includes('transactional mail sent')).toBe(true)
    expect(r.logs.includes('example.com')).toBe(true)
    expect(r.logs.includes('person@')).toBe(false)
    expect(r.logs.includes('482913')).toBe(false)
    noLeak(r.logs)
  })

  test('SENDGRID_FROM_EMAIL and SENDGRID_FROM_NAME override the defaults; SENDGRID_REPLY_TO is never a Reply-To (§12)', async () => {
    process.env.SENDGRID_FROM_EMAIL = 'alerts@zipperlive.org'
    process.env.SENDGRID_FROM_NAME = 'ZIPPER Alerts'
    process.env.SENDGRID_REPLY_TO = 'support@zipperlive.org'
    await MAIL.sendTransactionalMail(codeMail)
    const req = sg.requests[0]
    expect(req.body.from).toEqual({ email: 'alerts@zipperlive.org', name: 'ZIPPER Alerts' })
    expect(req.body.reply_to).toBe(undefined)
  })

  test('§12 identities on the wire: info/support from no-reply@ until switched on; never a Reply-To; tracking off', async () => {
    try {
      await MAIL.sendNotificationMail('owner@example.com', 'Weekly', '<p>r</p>', 'info')
      await MAIL.sendNotificationMail('owner@example.com', 'Ticket', '<p>t</p>', 'support')
      process.env.EMAIL_IDENTITY_INFO_ENABLED = 'true'
      process.env.EMAIL_IDENTITY_SUPPORT_ENABLED = 'true'
      await MAIL.sendNotificationMail('owner@example.com', 'Weekly', '<p>r</p>', 'info')
      await MAIL.sendNotificationMail('owner@example.com', 'Ticket', '<p>t</p>', 'support')
      await MAIL.sendNotificationMail('owner@example.com', 'Approved', '<p>a</p>', 'transactional')
      await MAIL.sendTransactionalMail(codeMail)
    } finally {
      delete process.env.EMAIL_IDENTITY_INFO_ENABLED
      delete process.env.EMAIL_IDENTITY_SUPPORT_ENABLED
    }
    expect(sg.requests.map((r) => r.body.from.email)).toEqual([
      'no-reply@zipperlive.org', 'no-reply@zipperlive.org',
      'info@zipperlive.org', 'support@zipperlive.org',
      'no-reply@zipperlive.org', 'no-reply@zipperlive.org',
    ])
    expect(sg.requests.every((r) => r.body.reply_to === undefined)).toBe(true)
    for (const r of sg.requests) expect(r.body.tracking_settings).toEqual(TRACKING_OFF)
  })

  test('an HTML-only notification gets a plain-text part that keeps its links', async () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Hi <strong>A &amp; B</strong>,</p>' +
      '<a href="https://zipperlive.web.app/login" style="x">Log In to CRM →</a></body></html>'
    await MAIL.sendNotificationMail('owner@example.com', 'Approved', html)
    const req = sg.requests[0]
    const text = content(req, 'text/plain')
    expect(text.includes('Hi A & B,')).toBe(true)
    expect(text.includes('Log In to CRM → (https://zipperlive.web.app/login)')).toBe(true)
    expect(text.includes('<')).toBe(false)
    expect(text.includes('color:red')).toBe(false)
    expect(content(req, 'text/html')).toBe(html)
    expect(req.body.tracking_settings).toEqual(TRACKING_OFF)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('retries: only when SendGrid did not accept the request', () => {
  test('429 then 202: sent again once, after 1 s; one email accepted', async () => {
    sg.script = [{ status: 429, body: { errors: [{ message: 'too many requests' }] } }, { status: 202 }]
    await MAIL.sendTransactionalMail(codeMail)
    expect(sg.requests.length).toBe(2)
    expect(waits).toEqual([1000])
  })

  test('503, 503, 202: three attempts, waits of 1 s then 2 s', async () => {
    sg.script = [{ status: 503 }, { status: 503 }, { status: 202 }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error).toBe(null)
    expect(sg.requests.length).toBe(3)
    expect(waits).toEqual([1000, 2000])
    expect(r.logs.includes('"attempts":3')).toBe(true)
  })

  test('503 three times: gives up after 3 attempts — a refusal, not an unknown outcome', async () => {
    sg.script = [{ status: 503 }, { status: 503 }, { status: 503 }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.code).toBe('503')
    expect(r.error.attempts).toBe(3)
    expect(r.error.outcomeUnknown).toBe(false)
    expect(sg.requests.length).toBe(3)
  })

  test('429 asking for a wait longer than the budget: not sent again', async () => {
    sg.script = [{ status: 429, headers: { 'retry-after': '60' } }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.attempts).toBe(1)
    expect(r.error.outcomeUnknown).toBe(false)
    expect(sg.requests.length).toBe(1)
    expect(waits).toEqual([])
  })

  test('429 with a short Retry-After waits that long', async () => {
    sg.script = [{ status: 429, headers: { 'retry-after': '3' } }, { status: 202 }]
    await MAIL.sendTransactionalMail(codeMail)
    expect(sg.requests.length).toBe(2)
    expect(waits).toEqual([3000])
  })

  for (const status of [500, 502, 504]) {
    test(`${status}: exactly one attempt — SendGrid may have accepted it, so it is not sent again`, async () => {
      sg.script = [{ status }]
      const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
      expect(r.error instanceof MAIL.MailSendError).toBe(true)
      expect(r.error.code).toBe(String(status))
      expect(r.error.attempts).toBe(1)
      expect(r.error.outcomeUnknown).toBe(true)
      expect(sg.requests.length).toBe(1)
      expect(r.logs.includes('"outcomeUnknown":true')).toBe(true)
      noLeak(r.logs)
    })
  }

  test('400 invalid recipient: one attempt, permanent, and the address is not echoed back', async () => {
    sg.script = [{ status: 400, body: { errors: [{ field: 'personalizations.0.to.0.email', message: 'bad.address@example Does not contain a valid address.' }] } }]
    const r = await capture(() => MAIL.sendNotificationMail('bad.address@example', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.code).toBe('400')
    expect(r.error.attempts).toBe(1)
    expect(r.error.outcomeUnknown).toBe(false)
    expect(r.error.message.includes('personalizations.0.to.0.email')).toBe(true)
    expect(r.error.message.includes('bad.address@')).toBe(false)
    expect(sg.requests.length).toBe(1)
  })

  test('401 (a revoked or wrong key): one attempt, permanent, and the key is nowhere', async () => {
    sg.script = [{ status: 401, body: { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked' }] } }]
    const r = await capture(() => MAIL.sendTransactionalMail(codeMail))
    expect(r.error instanceof MAIL.MailUnavailable).toBe(true)
    expect(sg.requests.length).toBe(1)
    expect(r.logs.includes('"reason":"401"')).toBe(true)
    noLeak(r.logs)
    noLeak(util.inspect(r.error, { depth: 20 }))
  })

  test('accepted and then never answered (a timeout): exactly one request — never a duplicate', async () => {
    MAIL.setRetryTimingForTests({ limits: { timeoutMs: 300, budgetMs: 5000, minRemainingMs: 100 } })
    sg.script = [{ kind: 'stall' }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.outcomeUnknown).toBe(true)
    expect(r.error.attempts).toBe(1)
    expect(sg.requests.length).toBe(1)
    expect(waits).toEqual([])
    noLeak(r.logs)
    noLeak(util.inspect(r.error, { depth: 20 }))
  })

  test('the connection dropped after the request was sent: exactly one request', async () => {
    sg.script = [{ kind: 'reset' }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.outcomeUnknown).toBe(true)
    expect(r.error.attempts).toBe(1)
    expect(sg.requests.length).toBe(1)
    noLeak(r.logs)
  })

  test('connection refused (nothing reached SendGrid): retried, then gives up after 3 attempts', async () => {
    const port = await closedPort()
    MAIL.setSendGridBaseUrlForTests(`http://127.0.0.1:${port}/`)
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    expect(r.error.code).toBe('ECONNREFUSED')
    expect(r.error.attempts).toBe(3)
    expect(r.error.outcomeUnknown).toBe(false)
    expect(waits).toEqual([1000, 2000])
    expect(sg.requests.length).toBe(0)
    noLeak(r.logs)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('the key never leaves in an error or a log', () => {
  test('a network failure: the error that reaches the caller (and its log line) has no key', async () => {
    // The SDK's own error for this case is the HTTP library's, holding the
    // request configuration and its Authorization header. Callers log what
    // they catch, exactly like this:
    const port = await closedPort()
    MAIL.setSendGridBaseUrlForTests(`http://127.0.0.1:${port}/`)
    const r = await capture(async () => {
      try {
        await MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>')
      } catch (err) {
        require('firebase-functions/v1').logger.error('Failed to send agency approval email:', err)
        throw err
      }
    })
    expect(r.error instanceof MAIL.MailSendError).toBe(true)
    for (const s of [util.inspect(r.error, { depth: 20 }), JSON.stringify(r.error), String(r.error), String(r.error.stack), r.logs]) {
      noLeak(s)
    }
  })

  test('an HTTP refusal: the same', async () => {
    sg.script = [{ status: 403, body: { errors: [{ message: 'access forbidden' }] } }]
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    for (const s of [util.inspect(r.error, { depth: 20 }), JSON.stringify(r.error), String(r.error), r.logs]) noLeak(s)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('the two contracts', () => {
  test('a notification without the key: logged and skipped, nothing sent, nothing thrown', async () => {
    delete process.env.ZIPPER_SENDGRID_API_KEY
    const r = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(r.error).toBe(null)
    expect(sg.requests.length).toBe(0)
    expect(r.logs.includes('ZIPPER_SENDGRID_API_KEY is not available')).toBe(true)
    expect(r.logs.includes('"hasKey":false')).toBe(true)
  })

  test('a code without the key: MailUnavailable, logged as not_configured, nothing sent', async () => {
    delete process.env.ZIPPER_SENDGRID_API_KEY
    const r = await capture(() => MAIL.sendTransactionalMail(codeMail))
    expect(r.error instanceof MAIL.MailUnavailable).toBe(true)
    expect(r.logs.includes('"reason":"not_configured"')).toBe(true)
    expect(sg.requests.length).toBe(0)
  })

  test('EMAIL_PROVIDER other than sendgrid: nothing is sent', async () => {
    process.env.EMAIL_PROVIDER = 'none'
    const a = await capture(() => MAIL.sendNotificationMail('owner@example.com', 'S', '<p>x</p>'))
    expect(a.error).toBe(null)
    const b = await capture(() => MAIL.sendTransactionalMail(codeMail))
    expect(b.error instanceof MAIL.MailUnavailable).toBe(true)
    expect(sg.requests.length).toBe(0)
  })

  test('a code that SendGrid refused: MailUnavailable — the caller never sees the SDK error', async () => {
    sg.script = [{ status: 500 }]
    const r = await capture(() => MAIL.sendTransactionalMail(codeMail))
    expect(r.error instanceof MAIL.MailUnavailable).toBe(true)
    expect(r.error.message).toBe('send failed')
    expect(r.logs.includes('"outcomeUnknown":true')).toBe(true)
    expect(r.logs.includes('482913')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('a code callable through the real transport', () => {
  const UID = 'SG1'
  const ANON = { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } }
  beforeEach(() => {
    db._docs.clear()
    db.seed(`users/${UID}`, { name: 'Guest sg', diamonds: 0 })
  })

  test('requestEmailBindCode: the code goes out through SendGrid, tracking off, never logged', async () => {
    const r = await capture(() => OTP.requestEmailBindCode.run({ email: 'Person@Example.com' }, { auth: { uid: UID, token: ANON } }))
    expect(r.error).toBe(null)
    expect(r.value.status).toBe('sent')
    expect(sg.requests.length).toBe(1)
    const req = sg.requests[0]
    expect(req.body.personalizations[0].to[0].email).toBe('person@example.com')
    expect(req.body.tracking_settings).toEqual(TRACKING_OFF)
    expect(req.body.from).toEqual({ email: 'no-reply@zipperlive.org', name: 'ZIPPER Live' })
    const code = (content(req, 'text/plain').match(/code is (\d{6})/) || [])[1]
    expect(/^\d{6}$/.test(code)).toBe(true)
    expect(r.logs.includes(code)).toBe(false)
    expect(r.logs.includes('person@')).toBe(false)
    noLeak(r.logs)
  })

  test('SendGrid answering 500: one request, the callable answers unavailable, the code is never logged', async () => {
    sg.script = [{ status: 500 }]
    const r = await capture(() => OTP.requestEmailBindCode.run({ email: 'person@example.com' }, { auth: { uid: UID, token: ANON } }))
    expect(r.error && r.error.code).toBe('unavailable')
    expect(sg.requests.length).toBe(1)
    const code = (content(sg.requests[0], 'text/plain').match(/code is (\d{6})/) || [])[1]
    expect(r.logs.includes(code)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('which functions are given the SendGrid key', () => {
  test('exactly the nine email functions declare ZIPPER_SENDGRID_API_KEY', () => {
    // Scheduled functions need a project id to describe themselves; a placeholder.
    const before = process.env.GCLOUD_PROJECT
    process.env.GCLOUD_PROJECT = before || 'demo-sendgrid-test'
    const index = require('../lib/index')
    const holders = []
    for (const [name, fn] of Object.entries(index)) {
      const ep = fn && fn.__endpoint
      const keys = ((ep && ep.secretEnvironmentVariables) || []).map((s) => s.key)
      if (keys.includes('ZIPPER_SENDGRID_API_KEY')) holders.push(name)
    }
    expect(holders.sort()).toEqual([
      'onAgencyApproved', 'onAgencyRegistered', 'onAgencyResendEmail', 'onSellerApproved',
      'onSellerRegistered', 'onSellerResendEmail', 'requestEmailBindCode', 'requestLoginEmailCode',
      'weeklyPayoutReportGenerator',
    ])
    const weekly = index.weeklyPayoutReportGenerator.__endpoint.secretEnvironmentVariables.map((s) => s.key)
    expect(weekly.includes('ZIPPER_ACCRUAL_KEY')).toBe(true)
    if (before === undefined) delete process.env.GCLOUD_PROJECT
    else process.env.GCLOUD_PROJECT = before
  })

  test('no function reads the old key, and the SDK is used only in mail.ts', () => {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')
    for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((x) => x.endsWith('.ts'))) {
      expect(src(f).includes('SG_MAIL_KEY')).toBe(false)
      if (f !== 'mail.ts') expect(src(f).includes('@sendgrid/mail')).toBe(false)
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('S6: applicant-supplied names are escaped in the email bodies', () => {
  test('escapeHtml', () => {
    expect(MAIL.escapeHtml(`<a href="x">A & B's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;A &amp; B&#39;s&lt;/a&gt;')
    expect(MAIL.escapeHtml(undefined)).toBe('')
  })

  test('a registration with markup in the names: the email shows it as text, it cannot add a link', async () => {
    const index = require('../lib/index')
    const evil = '<a href="https://evil.example/login">Verify your account</a>'
    const snap = { id: 'AG1', data: () => ({ ownerEmail: 'owner@example.com', ownerName: '<b>Owner</b>', agencyName: evil }) }
    await index.onAgencyRegistered.run(snap, { params: { agencyId: 'AG1' } })
    expect(sg.requests.length).toBe(1)
    const html = content(sg.requests[0], 'text/html')
    expect(html.includes(evil)).toBe(false)
    expect(html.includes('href="https://evil.example')).toBe(false)
    expect(html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;')).toBe(true)
    expect(html.includes('&lt;b&gt;Owner&lt;/b&gt;')).toBe(true)
  })

  test('no unescaped applicant value is left in the six trigger email bodies', () => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const bodies = code.match(/const html = `<!DOCTYPE html>[\s\S]*?<\/body><\/html>`/g) || []
    const triggerBodies = bodies.filter((b) => /escapeHtml\(/.test(b))
    expect(triggerBodies.length).toBe(8)
    for (const b of triggerBodies) {
      for (const n of ['ownerName', 'agencyName', 'email', 'signInWith', 'name', 'sellerName']) {
        expect(b.includes('${' + n + '}')).toBe(false)
      }
    }
  })
})

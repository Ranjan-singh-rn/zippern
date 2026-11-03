/**
 * QA #47 (3 Nov 2026) — the Functions speak with the official addresses.
 *
 * Owner decision, final: zipperlive.org, with no-reply@ for every automated
 * message and info@ / support@ as contacts. The partner emails sent from here
 * (registration received, approved — agency and seller) said "Reach us at" a
 * personal Gmail address. They now name support@zipperlive.org, read from one
 * place (`mail.supportContact`), and the sender stays no-reply@.
 *
 * REAL: `lib/mail.js` (compiled from src/mail.ts), imported and called; the
 * compiled `lib/index.js` and `src/index.ts` are read for the wiring.
 *
 * Run:  node --test test/qa47EmailIdentities.test.js
 */

const { test, describe, afterEach } = require('node:test')
const { expect } = require('./expect')
const fs = require('fs')
const path = require('path')

const mail = require('../lib/mail')

const saved = process.env.CONTACT_SUPPORT_EMAIL
afterEach(() => {
  if (saved === undefined) delete process.env.CONTACT_SUPPORT_EMAIL
  else process.env.CONTACT_SUPPORT_EMAIL = saved
})

describe('QA #47 — one domain, three addresses', () => {
  test('the three addresses', () => {
    expect(mail.OFFICIAL_EMAIL_DOMAIN).toBe('zipperlive.org')
    expect(mail.SUPPORT_EMAIL).toBe('support@zipperlive.org')
    expect(mail.INFO_EMAIL).toBe('info@zipperlive.org')
    expect(mail.MAIL_FROM.email).toBe('no-reply@zipperlive.org')
  })

  test('the support contact, and what may override it', () => {
    delete process.env.CONTACT_SUPPORT_EMAIL
    expect(mail.supportContact()).toBe('support@zipperlive.org')
    process.env.CONTACT_SUPPORT_EMAIL = 'Support@ZipperLive.org '
    expect(mail.supportContact()).toBe('support@zipperlive.org')
    // Not on the official domain: refused, the default stands.
    process.env.CONTACT_SUPPORT_EMAIL = 'someone@gmail.com'
    expect(mail.supportContact()).toBe('support@zipperlive.org')
    // The automated sender is never a contact.
    process.env.CONTACT_SUPPORT_EMAIL = 'no-reply@zipperlive.org'
    expect(mail.supportContact()).toBe('support@zipperlive.org')
  })

  test('automated mail leaves from no-reply@ while the info / support switches are off (their default)', () => {
    const table = mail.IDENTITY_TABLE
    expect(table.auth.stream).toBe('no-reply')
    expect(table.security.stream).toBe('no-reply')
    expect(table.transactional.stream).toBe('no-reply')
    expect(table.info.switchEnv).toBe('EMAIL_IDENTITY_INFO_ENABLED')
    expect(table.support.switchEnv).toBe('EMAIL_IDENTITY_SUPPORT_ENABLED')
  })

  test('the partner emails name support@, never the personal Gmail address', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    expect(src.includes('314zipper@gmail.com')).toBe(false)
    const uses = src.split('mailto:${escapeHtml(supportContact())}').length - 1
    expect(uses).toBe(4)
    const built = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8')
    expect(built.includes('314zipper@gmail.com')).toBe(false)
  })
})

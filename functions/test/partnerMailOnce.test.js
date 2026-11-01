/**
 * Spec §12 / F-20 / F-17 — the partner emails are sent once, "approved" only on
 * a real transition, and the weekly report goes to every active Owner.
 *
 * The real triggers from lib/index.js run against the fake Firestore; the mail
 * transport is replaced by a recorder (no network). What is pinned:
 *
 *   * a re-delivered `onAgencyRegistered` / `onSellerRegistered` /
 *     `onAgencyApproved` / `onSellerApproved` event sends nothing the second
 *     time: `mailLog/{docId}_{kind}` is created atomically before sending;
 *   * "approved" goes out only on a transition INTO approved, and once per
 *     partner — a reactivation (suspended → approved) does not repeat it;
 *   * a provably unsent mail (refused, no key) may be claimed again by a later
 *     delivery; one the provider MAY have taken (5xx, timeout) never is;
 *   * a staff resend is keyed on its event id: sent once per request, and an
 *     "approval" resend is refused for a partner that is not approved;
 *   * every partner mail leaves under identity `transactional`; the marker keeps
 *     the recipient's domain only;
 *   * the weekly report recipients are all active Owners (crmUsers role
 *     superadmin, isActive != false), de-duplicated, with no fallback address.
 *
 * Run:  node --test test/partnerMailOnce.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { expect } = require('./expect')
const { installFakeFirestore, FakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()
const FAKE_KEY = 'SG.FAKE-TEST-KEY-partnerMailOnce-0123456789'
process.env.ZIPPER_SENDGRID_API_KEY = FAKE_KEY

const LIB = process.env.ZIPPER_FUNCTIONS_LIB || path.join(__dirname, '..', 'lib')
const MAIL = require(path.join(LIB, 'mail'))
const LOG = require(path.join(LIB, 'mailLog'))
const IDX = require(path.join(LIB, 'index'))

// ── The transport: records every message; can be told to fail once ─────────
const sent = []
let failNext = null
MAIL.setMailTransportForTests(async (m) => {
  if (failNext) { const f = failNext; failNext = null; throw f }
  sent.push(m)
  return { attempts: 1 }
})

const snap = (col, id, data) => ({ id, data: () => data, ref: db.collection(col).doc(id) })
const change = (col, id, before, after) => ({
  before: { id, data: () => before, ref: db.collection(col).doc(id) },
  after: { id, data: () => after, ref: db.collection(col).doc(id) },
})
const marker = (id) => db.read(`mailLog/${id}`)
const agency = (extra = {}) => ({ ownerEmail: 'agency.owner@example.com', ownerName: 'A', agencyName: 'Alpha', ...extra })
const seller = (extra = {}) => ({ email: 'seller@example.com', displayName: 'S', ...extra })

beforeEach(() => {
  sent.length = 0
  failNext = null
  process.env.ZIPPER_SENDGRID_API_KEY = FAKE_KEY
})

// ══════════════════════════════════════════════════════════════════════════
describe('registration: once per document, however often the event is delivered', () => {
  test('onAgencyRegistered: a re-delivered onCreate sends nothing the second time', async () => {
    const s = snap('agencies', 'AG-R1', agency())
    await IDX.onAgencyRegistered.run(s, { eventId: 'c1', params: { agencyId: 'AG-R1' } })
    await IDX.onAgencyRegistered.run(s, { eventId: 'c1', params: { agencyId: 'AG-R1' } })
    expect(sent.length).toBe(1)
    expect(sent[0].identity).toBe('transactional')
    const m = marker('AG-R1_registered')
    expect(m.status).toBe('sent')
    expect(m.toDomain).toBe('example.com')
    expect(JSON.stringify(m).includes('agency.owner@')).toBe(false)
  })

  test('onSellerRegistered: the same, for sellers', async () => {
    const s = snap('sellers', 'SL-R1', seller())
    await IDX.onSellerRegistered.run(s, { eventId: 'c2', params: { sellerId: 'SL-R1' } })
    await IDX.onSellerRegistered.run(s, { eventId: 'c2', params: { sellerId: 'SL-R1' } })
    expect(sent.length).toBe(1)
    expect(marker('SL-R1_registered').status).toBe('sent')
  })

  test('no address: nothing sent, nothing claimed', async () => {
    await IDX.onAgencyRegistered.run(snap('agencies', 'AG-R2', agency({ ownerEmail: '' })), { eventId: 'c3', params: {} })
    expect(sent.length).toBe(0)
    expect(marker('AG-R2_registered')).toBe(undefined)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('"approved": only on a real transition, and once per partner', () => {
  const approve = (id, before, after) =>
    IDX.onAgencyApproved.run(change('agencies', id, agency(before), agency(after)), { eventId: `a-${id}`, params: { agencyId: id } })

  test('pending → approved sends; the re-delivered event does not', async () => {
    await approve('AG-A1', { status: 'pending' }, { status: 'approved' })
    await approve('AG-A1', { status: 'pending' }, { status: 'approved' })
    expect(sent.length).toBe(1)
    expect(sent[0].identity).toBe('transactional')
    expect(marker('AG-A1_approved').status).toBe('sent')
  })

  test('no transition (approved → approved, an edit) sends nothing', async () => {
    await approve('AG-A2', { status: 'approved' }, { status: 'approved' })
    await approve('AG-A2', { status: 'pending' }, { status: 'rejected' })
    expect(sent.length).toBe(0)
  })

  test('a reactivation (suspended → approved) does not repeat the approval email', async () => {
    await approve('AG-A3', { status: 'pending' }, { status: 'approved' })
    await approve('AG-A3', { status: 'approved' }, { status: 'suspended' })
    await approve('AG-A3', { status: 'suspended' }, { status: 'approved' })
    expect(sent.length).toBe(1)
  })

  test('onSellerApproved: false → true once; repeats and true → true send nothing', async () => {
    const run = (id, before, after) =>
      IDX.onSellerApproved.run(change('sellers', id, seller(before), seller(after)), { eventId: `s-${id}`, params: { sellerId: id } })
    await run('SL-A1', { isApproved: false }, { isApproved: true })
    await run('SL-A1', { isApproved: false }, { isApproved: true })
    await run('SL-A1', { isApproved: true }, { isApproved: true })
    expect(sent.length).toBe(1)
    expect(marker('SL-A1_approved').status).toBe('sent')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('a failed send: retried only when it provably did not go', () => {
  const approve = (id) => IDX.onAgencyApproved.run(
    change('agencies', id, agency({ status: 'pending' }), agency({ status: 'approved' })),
    { eventId: `f-${id}`, params: { agencyId: id } })

  test('refused (not accepted) → marker failed → the next delivery sends it', async () => {
    failNext = new MAIL.MailSendError('400', 400, 1, false)
    await approve('AG-F1')
    expect(sent.length).toBe(0)
    expect(marker('AG-F1_approved').status).toBe('failed')
    await approve('AG-F1')
    expect(sent.length).toBe(1)
    expect(marker('AG-F1_approved').status).toBe('sent')
    expect(marker('AG-F1_approved').attempts).toBe(2)
  })

  test('outcome unknown (a 5xx / timeout) → never sent again automatically', async () => {
    failNext = new MAIL.MailSendError('500', 500, 1, true)
    await approve('AG-F2')
    expect(marker('AG-F2_approved').status).toBe('unknown')
    await approve('AG-F2')
    expect(sent.length).toBe(0)
  })

  test('no SendGrid key → recorded failed (not "sent"), and sent once the key is there', async () => {
    delete process.env.ZIPPER_SENDGRID_API_KEY
    await approve('AG-F3')
    expect(marker('AG-F3_approved').status).toBe('failed')
    expect(marker('AG-F3_approved').error).toBe('not_configured')
    process.env.ZIPPER_SENDGRID_API_KEY = FAKE_KEY
    await approve('AG-F3')
    expect(sent.length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('a staff resend: once per request; "approval" only when approved', () => {
  test('onAgencyResendEmail: one send per flag flip, none on its re-delivery', async () => {
    db.seed('agencies/AG-S1', agency({ status: 'approved' }))
    const flip = change('agencies', 'AG-S1', agency({ status: 'approved' }),
      agency({ status: 'approved', _resendEmail: 'registration' }))
    await IDX.onAgencyResendEmail.run(flip, { eventId: 'r-1', params: { agencyId: 'AG-S1' } })
    await IDX.onAgencyResendEmail.run(flip, { eventId: 'r-1', params: { agencyId: 'AG-S1' } })
    expect(sent.length).toBe(1)
    // A NEW request (another flag flip) is a deliberate second email.
    await IDX.onAgencyResendEmail.run(flip, { eventId: 'r-2', params: { agencyId: 'AG-S1' } })
    expect(sent.length).toBe(2)
    expect(sent.every((m) => m.identity === 'transactional')).toBe(true)
  })

  test('an "approval" resend for an agency that is not approved sends nothing', async () => {
    db.seed('agencies/AG-S2', agency({ status: 'pending' }))
    const flip = change('agencies', 'AG-S2', agency({ status: 'pending' }),
      agency({ status: 'pending', _resendEmail: 'approval' }))
    await IDX.onAgencyResendEmail.run(flip, { eventId: 'r-3', params: { agencyId: 'AG-S2' } })
    expect(sent.length).toBe(0)
  })

  test('onSellerResendEmail: "approval" only for an approved seller, once per request', async () => {
    db.seed('sellers/SL-S1', seller({ isApproved: false }))
    const notYet = change('sellers', 'SL-S1', seller({ isApproved: false }),
      seller({ isApproved: false, _resendEmail: 'approval' }))
    await IDX.onSellerResendEmail.run(notYet, { eventId: 'r-4', params: { sellerId: 'SL-S1' } })
    expect(sent.length).toBe(0)
    db.seed('sellers/SL-S2', seller({ isApproved: true }))
    const ok = change('sellers', 'SL-S2', seller({ isApproved: true }),
      seller({ isApproved: true, _resendEmail: 'approval' }))
    await IDX.onSellerResendEmail.run(ok, { eventId: 'r-5', params: { sellerId: 'SL-S2' } })
    await IDX.onSellerResendEmail.run(ok, { eventId: 'r-5', params: { sellerId: 'SL-S2' } })
    expect(sent.length).toBe(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('F-17: the weekly payout report goes to every active Owner, with no fallback', () => {
  test('all active superadmins with an address, de-duplicated; inactive, address-less and other roles excluded', async () => {
    const store = new FakeFirestore()
    store.seed('crmUsers/o1', { role: 'superadmin', email: 'Owner.One@zipperlive.test' })            // isActive absent = active
    store.seed('crmUsers/o2', { role: 'superadmin', email: 'owner2@zipperlive.test', isActive: true })
    store.seed('crmUsers/o3', { role: 'superadmin', email: 'gone@zipperlive.test', isActive: false })
    store.seed('crmUsers/o4', { role: 'superadmin' })
    store.seed('crmUsers/o5', { role: 'superadmin', email: 'OWNER2@zipperlive.test' })
    store.seed('crmUsers/a1', { role: 'admin', email: 'admin@zipperlive.test' })
    expect(await LOG.activeOwnerEmails(store)).toEqual(['owner.one@zipperlive.test', 'owner2@zipperlive.test'])
  })

  test('no active Owner → an empty list (the generator logs and skips; nothing is invented)', async () => {
    const store = new FakeFirestore()
    store.seed('crmUsers/o3', { role: 'superadmin', email: 'gone@zipperlive.test', isActive: false })
    expect(await LOG.activeOwnerEmails(store)).toEqual([])
  })

  test('the generator uses that list, under identity info, with no hard-coded address', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const start = code.indexOf('export const weeklyPayoutReportGenerator')
    const end = code.indexOf('\nexport const ', start + 10)
    const weekly = code.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(weekly.includes('activeOwnerEmails(db)')).toBe(true)
    expect(/where\('role', '==', 'superadmin'\)\.limit\(1\)/.test(weekly)).toBe(false)
    expect(/['"`][^'"`\s]+@gmail\.com['"`]/.test(weekly)).toBe(false)
    expect(weekly.includes("sendMail(ownerEmail, subject, emailHtml, 'info')")).toBe(true)
  })

  test('every partner trigger sends through the once-only path (no direct sendMail to a partner)', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect(/sendMail\(email,/.test(code)).toBe(false)
    expect((code.match(/sendPartnerMailOnce\(/g) || []).length).toBeGreaterThanOrEqual(9)
  })
})

describe('the identity table matches the backend', () => {
  test('same switch names; every identity resolves; no Reply-To; info/support fall back to no-reply by default', () => {
    expect(MAIL.IDENTITY_TABLE.info.switchEnv).toBe('EMAIL_IDENTITY_INFO_ENABLED')
    expect(MAIL.IDENTITY_TABLE.support.switchEnv).toBe('EMAIL_IDENTITY_SUPPORT_ENABLED')
    for (const id of ['auth', 'security', 'transactional', 'info', 'support']) {
      const r = MAIL.identityResolution(id)
      expect(r.from.email).toBe('no-reply@zipperlive.org')
      expect(r.replyTo).toBe('')
      expect(r.tracking).toBe('off')
    }
    const backend = path.join(__dirname, '..', '..', 'backend', 'app', 'config.py')
    if (fs.existsSync(backend)) {
      const cfg = fs.readFileSync(backend, 'utf8')
      expect(cfg.includes('email_identity_info_enabled: bool = False')).toBe(true)
      expect(cfg.includes('email_identity_support_enabled: bool = False')).toBe(true)
    }
  })
})

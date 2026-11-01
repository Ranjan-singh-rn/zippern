/**
 * F-18 — `weeklyPayoutReportGenerator` (index.ts section 1), one basic run
 * against the in-memory Firestore (lib/, as deployed).
 *
 * One approved, active agency with two hosts. Pinned:
 *
 *   * the report document `weeklyPayoutReports/{ISO week label}` and its
 *     `hostPayouts` subcollection, one row per eligible host;
 *   * host earnings are this report's rolling seven days of bean CREDITS
 *     (other row types and older credits are not counted), valued at
 *     appConfig/economy's bean rate and filtered by its weekly minimum;
 *   * the ISO week label, including the year boundary: the run of Sunday
 *     10 Jan 2027 files the closed week as 2026-W53 (F-4 / M-7);
 *   * with no mail key, no email is sent (and the log says so, without the
 *     address); with no accrual key, no HTTP request is made and the report
 *     says commission did not accrue.
 *
 * SendGrid is replaced by a recording transport and `fetch` by a recorder that
 * refuses: nothing here can reach the network.
 *
 * Run:  node --test test/weeklyPayoutReportGenerator.test.js
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test')
const { expect } = require('./expect')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

const db = installFakeFirestore()
// Scheduled functions need a project id to describe themselves; a placeholder.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-weekly-report'
// No credentials of any kind: the mail key and the accrual key are both absent.
delete process.env.ZIPPER_SENDGRID_API_KEY
delete process.env.ZIPPER_ACCRUAL_KEY
delete process.env.ZIPPER_API_BASE_URL

// Any HTTP request is recorded and refused.
const fetchCalls = []
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url))
  throw new Error('network access is not allowed in this test')
}

const MAIL = require('../lib/mail')
const mailSent = []
MAIL.setMailTransportForTests(async (message) => { mailSent.push(message); return { attempts: 1 } })

const index = require('../lib/index')

const DAY_MS = 24 * 60 * 60 * 1000
const RUN = Date.parse('2027-01-10T18:29:00Z')        // the cron `29 18 * * 0`, Sunday 10 Jan 2027
const LABEL = '2026-W53'
const generate = () => index.weeklyPayoutReportGenerator.run({})

function credit(uid, id, amount, atMs, type = 'credit') {
  db.seed(`users/${uid}/beanTransactions/${id}`, { type, amount, timestamp: Timestamp.fromMillis(atMs) })
}

/** One agency, two hosts; every timestamp relative to the run being simulated. */
function seedWorld(runMs) {
  db._docs.clear()
  db.seed('appConfig/economy', { weeklyMinPayoutInr: 2000, giftRates: { beanToInrRate: 0.01 } })
  db.seed('crmUsers/OWNER', { role: 'superadmin', email: 'owner@example.com' })
  db.seed('agencies/AG1', {
    agencyName: 'Sunrise Agency', status: 'approved', isActive: true, type: 'main', paymentType: 'domestic',
  })
  db.seed('agencies/AG1/agencyHosts/H1', { uid: 'H1', name: 'Asha' })
  db.seed('agencies/AG1/agencyHosts/H2', { uid: 'H2', name: 'Bina' })
  // H1: 250,000 beans in the window = ₹2,500.
  credit('H1', 'a', 150_000, runMs - 2 * DAY_MS)
  credit('H1', 'b', 100_000, runMs - 60 * 60 * 1000)
  credit('H1', 'released', 999_999, runMs - DAY_MS, 'release')   // not a credit: not counted
  credit('H1', 'old', 500_000, runMs - 8 * DAY_MS)                // before the window: not counted
  // H2: 310,000 beans = ₹3,100, one of them on the window's first instant.
  credit('H2', 'edge', 10_000, runMs - 7 * DAY_MS)
  credit('H2', 'c', 300_000, runMs - 3 * DAY_MS)
}

/** Everything written to stdout/stderr (the functions logger) while `fn` runs. */
async function logsOf(fn) {
  const chunks = []
  const ow = process.stdout.write, ew = process.stderr.write
  process.stdout.write = function (c, ...a) { chunks.push(String(c)); return ow.call(this, c, ...a) }
  process.stderr.write = function (c, ...a) { chunks.push(String(c)); return ew.call(this, c, ...a) }
  try {
    await fn()
  } finally {
    process.stdout.write = ow
    process.stderr.write = ew
  }
  return chunks.join('')
}

beforeEach(() => {
  mailSent.length = 0
  fetchCalls.length = 0
  mock.timers.enable({ apis: ['Date'], now: RUN })
  seedWorld(RUN)
})
afterEach(() => {
  mock.timers.reset()
  delete process.env.ZIPPER_SENDGRID_API_KEY
})

describe('a basic weekly run: one agency, two hosts', () => {
  test('the report document, under the ISO week label of the closed week', async () => {
    await generate()
    const report = db.read(`weeklyPayoutReports/${LABEL}`)
    expect(report.weekLabel).toBe(LABEL)
    expect(report.accrualPeriodLabel).toBe(LABEL)
    expect(report.weekStart.toMillis()).toBe(RUN - 7 * DAY_MS)
    expect(report.weekEnd.toMillis()).toBe(RUN)
    expect(report.accrualWindowStart.toMillis()).toBe(Date.parse('2026-12-28T00:00:00Z'))
    expect(report.accrualWindowEnd.toMillis()).toBe(Date.parse('2027-01-04T00:00:00Z'))
    expect(report.status).toBe('generated')
    expect(report.totalAgencies).toBe(1)
    expect(report.totalEligibleAgencies).toBe(1)
    expect(report.totalEligibleHosts).toBe(2)
    expect(report.grandTotalHostPayoutInr).toBe(5600)
    expect(report.minHostPayoutInr).toBe(2000)
    expect(report.beanToInrRate).toBe(0.01)
    expect(report.provisional).toBe(false)

    expect(report.agencySummaries.length).toBe(1)
    const a = report.agencySummaries[0]
    expect(a.agencyId).toBe('AG1')
    expect(a.agencyName).toBe('Sunrise Agency')
    expect(a.agencyType).toBe('main')
    expect(a.hostCount).toBe(2)
    expect(a.eligibleHostCount).toBe(2)
    expect(a.totalBeansEarned).toBe(560_000)
    expect(a.totalHostPayoutInr).toBe(5600)
    expect(db.count('weeklyPayoutReports')).toBe(3)    // the report and its two host rows
  })

  test('one hostPayouts row per eligible host, valued from bean credits in the window only', async () => {
    await generate()
    const rows = db.all(`weeklyPayoutReports/${LABEL}/hostPayouts`)
    expect(rows.map((r) => r.id).sort()).toEqual(['AG1_H1', 'AG1_H2'])
    const h1 = db.read(`weeklyPayoutReports/${LABEL}/hostPayouts/AG1_H1`)
    expect(h1.agencyId).toBe('AG1')
    expect(h1.agencyName).toBe('Sunrise Agency')
    expect(h1.hostUid).toBe('H1')
    expect(h1.hostName).toBe('Asha')
    expect(h1.weekBeans).toBe(250_000)
    expect(h1.hostPayoutInr).toBe(2500)
    expect(h1.weekLabel).toBe(LABEL)
    expect(h1.status).toBe('pending')
    expect(h1.eligible).toBe(true)
    const h2 = db.read(`weeklyPayoutReports/${LABEL}/hostPayouts/AG1_H2`)
    expect(h2.hostName).toBe('Bina')
    expect(h2.weekBeans).toBe(310_000)
    expect(h2.hostPayoutInr).toBe(3100)
  })

  test('no mail key: no email is sent, the log says so, and the address is not logged', async () => {
    const logs = await logsOf(generate)
    expect(mailSent.length).toBe(0)
    expect(logs.includes('ZIPPER_SENDGRID_API_KEY is not available to this function')).toBe(true)
    expect(logs.includes('owner@example.com')).toBe(false)
  })

  test('no accrual key: no HTTP request; the report says commission did not accrue, per agency', async () => {
    await generate()
    expect(fetchCalls.length).toBe(0)
    const report = db.read(`weeklyPayoutReports/${LABEL}`)
    expect(report.commissionAccrued).toBe(false)
    expect(report.commissionAccrual.ran).toBe(false)
    expect(report.commissionAccrual.status).toBe('skipped_not_configured')
    expect(report.commissionAccrual.reason.includes('ZIPPER_ACCRUAL_KEY is not set')).toBe(true)
    expect(report.agencySummaries[0].commissionOutcome).toBe('not_attempted')
    expect(report.agencySummaries[0].commissionNeedsPerson).toBe(true)
  })

  test('control: with a mail key the same run hands exactly one email to the transport', async () => {
    process.env.ZIPPER_SENDGRID_API_KEY = 'SG.fake-key-for-this-test-only'
    await generate()
    expect(mailSent.length).toBe(1)
    expect(mailSent[0].to).toBe('owner@example.com')
    expect(mailSent[0].subject).toBe(
      `Zipper Weekly Payout Report — ${LABEL} — ACTION NEEDED: commission did NOT accrue`)
    expect(mailSent[0].html.includes('Sunrise Agency')).toBe(true)
    expect(fetchCalls.length).toBe(0)
  })
})

describe('the ISO week label', () => {
  test('a mid-year run files the closed week under its own label: Sunday 1 Nov 2026 -> 2026-W43', async () => {
    const run = Date.parse('2026-11-01T18:29:00Z')
    mock.timers.setTime(run)
    seedWorld(run)
    await generate()
    expect(db.has('weeklyPayoutReports/2026-W43')).toBe(true)
    expect(db.read('weeklyPayoutReports/2026-W43/hostPayouts/AG1_H2').weekBeans).toBe(310_000)
  })
})

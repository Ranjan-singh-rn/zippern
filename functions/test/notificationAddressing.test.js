/**
 * Every notification this file writes must be readable by the person it is for
 * — and most of them are no longer written here at all.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 *
 * `index.ts` had four writers into the top-level `notifications` collection,
 * all addressing the document with `targetUid`. The deployed rule tests
 * `userId`, so every read was denied and nobody ever saw one.
 *
 * ── WHERE THEY WENT ──────────────────────────────────────────────────────────
 *
 * The partner-role lifecycle and the recharge flow are decided by the API now,
 * and the API writes the in-app notice for each event through one idempotent
 * writer (`backend/app/services/notices.py`). So:
 *
 *   · `agency_approved`                → API (`approve_partner`). The trigger
 *                                        keeps the email only.
 *   · `recharge_approved/delayed`      → API (`recharges.py`); the legacy
 *                                        credit-on-status-flip is gone, and the
 *                                        trigger now REVERTS a client approval.
 *   · `payout_approved`                → still here, on `userId`.
 *
 * What this test asserts is therefore: the one remaining writer is addressed
 * correctly, the retired ones have not crept back, and the legacy credit path
 * cannot mint diamonds on a client's word.
 *
 * Run:  node --test test/notificationAddressing.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const SRC = fs.readFileSync(path.join(REPO, 'functions', 'src', 'index.ts'), 'utf8')
const RULES = fs.readFileSync(path.join(REPO, 'firestore.rules'), 'utf8')

/**
 * The source with `//` comment lines removed.
 *
 * The comments say "targetUid" deliberately — they record what was wrong and
 * why the field is what it is. Asserting against the raw text would make those
 * explanations fail the test, which is exactly the pressure that gets a useful
 * comment deleted.
 */
const code = SRC.split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

describe('the deployed rule decides the field name', () => {
  test('the /notifications rule reads `userId`', () => {
    const block = RULES.match(/match \/notifications\/\{\w+\}\s*\{([\s\S]*?)\n {4}\}/)
    expect(block).toBeTruthy()
    expect(block[1].includes('resource.data.userId == request.auth.uid')).toBe(true)
  })

  test('…and not `targetUid`', () => {
    const block = RULES.match(/match \/notifications\/\{\w+\}\s*\{([\s\S]*?)\n {4}\}/)
    expect(block[1].includes('targetUid')).toBe(false)
  })
})

describe('every writer addresses the person the rule will check', () => {
  test('exactly one notification writer remains in index.ts (payout_approved)', () => {
    const writers = code.match(/collection\('notifications'\)/g) || []
    expect(writers.length).toBe(1)
    expect(code.includes("type:      'payout_approved'")).toBe(true)
  })

  test('the agency-approved in-app notice is the API\'s now, not this file\'s', () => {
    expect(code.includes("type: 'agency_approved'")).toBe(false)
    // …and the trigger still sends the email.
    const trigger = code.slice(code.indexOf('onAgencyApproved'))
    expect(trigger.includes('sendMail') || trigger.includes('signInHint')).toBe(true)
  })

  test('the legacy recharge credit is gone and a client approval is reverted', () => {
    const fn = code.slice(code.indexOf('onRechargeApproved'), code.indexOf('onAgencyApproved'))
    expect(fn.includes('creditedByLedger')).toBe(true)
    expect(fn.includes("status: 'pending'")).toBe(true)
    expect(fn.includes('recharge_client_approval_blocked')).toBe(true)
    // No transaction that moves coins or diamonds survives in this trigger.
    expect(fn.includes('runTransaction')).toBe(false)
    expect(fn.includes('diamondTransactions')).toBe(false)
  })

  test('none of them emits `targetUid`', () => {
    const offenders = code
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\btargetUid\s*:/.test(line))
    expect(offenders.map(([n]) => n)).toEqual([])
  })

  test('the remaining one emits `userId`', () => {
    const addressed = (code.match(/\buserId\s*:/g) || []).length
    expect(addressed).toBeGreaterThanOrEqual(1)
  })

  test('each one carries createdAt — Firestore drops a document from an orderBy on a field it lacks', () => {
    // The app reads this collection ordered by `createdAt`. A notification
    // written without one is not merely unsorted: it is excluded from the
    // result entirely, which looks identical to never having been written.
    const blocks = code.split(/collection\('notifications'\)/).slice(1)
    expect(blocks.length).toBe(1)
    for (const block of blocks) {
      // The object literal that follows the call, up to its closing brace.
      const body = block.slice(0, block.indexOf('\n      })') + 1) || block.slice(0, 600)
      expect(body.includes('createdAt')).toBe(true)
    }
  })

  test('each one marks itself unread, so the app can show a dot', () => {
    const blocks = code.split(/collection\('notifications'\)/).slice(1)
    for (const block of blocks) {
      const body = block.slice(0, 600)
      expect(/isRead:\s*false/.test(body)).toBe(true)
    }
  })
})

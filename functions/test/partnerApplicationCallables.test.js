/**
 * The "Join as …" and recharge callables are a proxy, not a decider.
 *
 * ── WHAT THEY MUST DO ────────────────────────────────────────────────────────
 *
 *   · refuse an unauthenticated caller;
 *   · forward the uid FROM THE TOKEN, never from the payload — a client that
 *     sends `applicant_uid` or `buyer_uid` in `data` is ignored;
 *   · present the partner-registration key, and only that key;
 *   · hit the API's application and recharge routes, and nothing else;
 *   · apply no rule of their own beyond input shape.
 *
 * The callables are `functions.https.onCall` wrappers over a `fetch`, so
 * — like the other wiring tests in this directory — this reads the source. A
 * callable that quietly started trusting `data.applicantUid` would still type-
 * check and still deploy; this is what notices.
 *
 * Run:  node --test test/partnerApplicationCallables.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')
const start = SRC.indexOf('13b. APPLYING FOR A PARTNER ROLE FROM THE APP')
const section = SRC.slice(start, SRC.indexOf('// ── Gift settlement', start))
const code = section.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

const CALLABLES = [
  'partnerEligibility', 'partnerParents', 'myPartnerApplications',
  'submitPartnerApplication', 'submitHostApplication', 'submitRechargeRequest',
  // C2 (B05): the reinstatement request for a revoked role, on the same bridge.
  'submitRoleAppeal', 'myRoleAppeals',
  // Decision 15 (RC): an approved role waiting for BOTH verified contacts.
  'partnerVerificationState', 'checkPartnerActivation', 'reportContactConflict',
]

function body(name) {
  const at = code.indexOf(`export const ${name} =`)
  expect(at).toBeGreaterThan(-1)
  const next = CALLABLES.map((n) => code.indexOf(`export const ${n} =`, at + 1)).filter((i) => i > at)
  return code.slice(at, next.length ? Math.min(...next) : undefined)
}

describe('every callable is authenticated and forwards the token uid', () => {
  for (const name of CALLABLES) {
    test(`${name} requires a signed-in caller`, () => {
      expect(body(name).includes('requireUid(context)')).toBe(true)
    })
  }

  test('requireUid reads context.auth and refuses without it', () => {
    const fn = code.slice(code.indexOf('function requireUid'), code.indexOf('export const partnerEligibility'))
    expect(fn.includes('context.auth?.uid')).toBe(true)
    expect(fn.includes("'unauthenticated'")).toBe(true)
  })

  test('the applicant uid sent to the API is the token uid, never data', () => {
    for (const name of ['submitPartnerApplication', 'submitHostApplication']) {
      const b = body(name)
      expect(b.includes('applicant_uid: uid')).toBe(true)
      expect(/applicant_uid:\s*data/.test(b)).toBe(false)
      expect(/data\.applicant/.test(b)).toBe(false)
      expect(/data\.uid/.test(b)).toBe(false)
    }
    const r = body('submitRechargeRequest')
    expect(r.includes('buyer_uid: uid')).toBe(true)
    expect(/buyer_uid:\s*data/.test(r)).toBe(false)
  })

  test('eligibility and applications are read for the token uid only', () => {
    expect(body('partnerEligibility').includes('encodeURIComponent(uid)')).toBe(true)
    expect(body('myPartnerApplications').includes('encodeURIComponent(uid)')).toBe(true)
    expect(/data\?\.uid|data\.uid/.test(body('partnerEligibility'))).toBe(false)
  })

  test('Decision 15: verification is read, checked and reported for the token uid only', () => {
    expect(body('partnerVerificationState').includes('encodeURIComponent(uid)')).toBe(true)
    for (const name of ['checkPartnerActivation', 'reportContactConflict']) {
      const b = body(name)
      expect(b.includes('applicant_uid: uid')).toBe(true)
      expect(/applicant_uid:\s*data/.test(b)).toBe(false)
      expect(/data\?\.uid|data\.uid|data\?\.applicant|data\.applicant/.test(b)).toBe(false)
    }
    // Starting a role is a protected operation, gated like an application.
    expect(body('checkPartnerActivation').includes("assertActiveSession(uid, data, 'checkPartnerActivation'")).toBe(true)
    // The conflict answer does not say whether a holder exists.
    expect(body('reportContactConflict').includes('return { received: true }')).toBe(true)
  })

  test('C2: reinstatement requests are filed and read for the token uid only', () => {
    const submit = body('submitRoleAppeal')
    expect(/\buid,/.test(submit)).toBe(true)
    expect(/uid:\s*data/.test(submit)).toBe(false)
    expect(/data\?\.uid|data\.uid/.test(submit)).toBe(false)
    const mine = body('myRoleAppeals')
    expect(mine.includes('encodeURIComponent(uid)')).toBe(true)
    expect(/data\?\.uid|data\.uid/.test(mine)).toBe(false)
  })
})

describe('the credential and the routes', () => {
  test('they present the partner-registration key and no other', () => {
    expect(code.includes('secrets: [PARTNER_REGISTRATION_KEY_ENV]')).toBe(true)
    expect(code.includes('readServiceConfig(PARTNER_REGISTRATION_KEY_ENV')).toBe(true)
    expect(code.includes('ACCRUAL_KEY_ENV')).toBe(false)
    expect(code.includes('REPORTING_KEY')).toBe(false)
  })

  test('they call exactly the application, recharge and reinstatement-request routes', () => {
    const paths = [...code.matchAll(/'\/api\/partner-ops\/[^'`]+'|`\/api\/partner-ops\/[^`]+`/g)].map((m) => m[0])
    const stripped = paths.map((p) => p.replace(/[`']/g, '').replace(/\$\{[^}]+\}/g, 'X').replace(/\?.*$/, ''))
    expect(new Set(stripped)).toEqual(new Set([
      '/api/partner-ops/applications/eligibility/X',
      '/api/partner-ops/applications/parents',
      '/api/partner-ops/applications/of/X',
      '/api/partner-ops/applications',
      '/api/partner-ops/applications/host',
      '/api/partner-ops/recharges',
      // C2 adds these two, and only these: file a request, read your own.
      '/api/partner-ops/role-appeals',
      '/api/partner-ops/role-appeals/of/X',
      // Decision 15 (RC): read your own verification, start what it now
      // allows (the API re-reads it), report a contact held elsewhere.
      '/api/partner-ops/applications/verification/X',
      '/api/partner-ops/applications/verification/check',
      '/api/partner-ops/applications/verification/conflict',
    ]))
    // Nothing that approves, moves money or touches a partner record.
    expect(code.includes('/approve')).toBe(false)
    expect(code.includes('/partners/')).toBe(false)
    expect(code.includes('/refund')).toBe(false)
  })

  test('an API refusal becomes failed-precondition with the API sentence', () => {
    const fn = code.slice(code.indexOf('function apiRefusalToHttpsError'), code.indexOf('async function viaApi'))
    expect(fn.includes("'failed-precondition'")).toBe(true)
    expect(fn.includes('apiMessage(result.body)')).toBe(true)
    // A credential problem is NOT shown to the user as such.
    expect(fn.includes("'internal'")).toBe(true)
  })

  test('the callables write nothing to Firestore themselves', () => {
    expect(/db\.collection\(/.test(code)).toBe(false)
    expect(/\.set\(|\.update\(|\.add\(/.test(code)).toBe(false)
  })
})

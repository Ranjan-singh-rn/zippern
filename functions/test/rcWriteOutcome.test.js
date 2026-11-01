/**
 * RF-30 — a write the API may have carried out is never reported as "failed".
 *
 * The partner bridge gives the API 25 s (`REQUEST_TIMEOUT_MS`). When the API
 * filed an application but answered late, the callable used to throw
 * `unavailable` "Zipper could not be reached. Please try again." — a person
 * whose application WAS filed was told it was not, pressed Submit again and
 * met "Your application is already with a reviewer". A recharge filed with a
 * screenshot and no reference could be filed twice.
 *
 * Now, for a WRITE (POST):
 *   · a timeout, an undeliverable request or a 5xx → `deadline-exceeded` with
 *     `details.code = OUTCOME_UNKNOWN` and a sentence that says exactly that;
 *   · 409 → `failed-precondition` with the API's own sentence;
 *   · 422 → `invalid-argument`;
 *   · 400/404 and 401/403 are unchanged.
 * A READ keeps `unavailable` — repeating it is harmless.
 * The recharge callable forwards one `client_request_id` per form, so the API
 * can answer a repeat with the request it already filed.
 *
 * The shipped callables (lib/, as deployed) with `fetch` replaced before
 * anything runs; the API origin is a `.test` name, so nothing leaves the
 * process. Run:  node --test test/rcWriteOutcome.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')

const { installFakeFirestore } = require('./fakeFirestore')
installFakeFirestore()

const KEY = 'k'.repeat(40)
const BASE = 'https://api.zipper.test'

// ── the API, as a scripted recorder ─────────────────────────────────────────
const sent = []
let behaviour = { kind: 'reply', status: 201, body: { id: 'APP-1', status: 'pending', kind: 'agency' } }
globalThis.fetch = async (url, init) => {
  sent.push({
    url: String(url),
    method: init && init.method,
    body: init && init.body ? JSON.parse(init.body) : undefined,
  })
  if (behaviour.kind === 'timeout') {
    // What AbortController.abort() produces when REQUEST_TIMEOUT_MS fires.
    const e = new Error('This operation was aborted')
    e.name = 'AbortError'
    throw e
  }
  if (behaviour.kind === 'unreachable') throw new TypeError('fetch failed')
  const { status, body, raw } = behaviour
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (raw !== undefined ? raw : JSON.stringify(body)),
  }
}

const index = require('../lib/index')

const ctx = (uid) => ({ auth: { uid, token: { auth_time: 2000 } } })
const applyAgency = () => index.submitPartnerApplication.run({ kind: 'agency', form: { agencyName: 'A' } }, ctx('U1'))
const applyHost = () => index.submitHostApplication.run({ parentId: 'AG1', form: { hostName: 'H' } }, ctx('U1'))
const recharge = (over = {}) => index.submitRechargeRequest.run({
  sellerId: 'SELL', diamonds: 100, amountMinor: 10000, currency: 'INR',
  paymentMethod: 'upi', reference: '', proofUrl: 'https://x/p.jpg', ...over,
}, ctx('U1'))
const readMine = () => index.myPartnerApplications.run({}, ctx('U1'))

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

beforeEach(() => {
  sent.length = 0
  behaviour = { kind: 'reply', status: 201, body: { id: 'APP-1', status: 'pending', kind: 'agency' } }
  process.env.ZIPPER_PARTNER_REGISTRATION_KEY = KEY
  process.env.ZIPPER_API_BASE_URL = BASE
})

describe('a write whose outcome is unknown says so', () => {
  test('an application the API answered too late is OUTCOME_UNKNOWN, not "could not be reached"', async () => {
    behaviour = { kind: 'timeout' }
    const e = await refusal(applyAgency())
    expect(e && e.code).toBe('deadline-exceeded')
    expect(e.details && e.details.code).toBe('OUTCOME_UNKNOWN')
    expect(/cannot tell whether this went through/.test(e.message)).toBe(true)
    expect(/could not be reached/i.test(e.message)).toBe(false)
    expect(sent.length).toBe(1)            // asked once — the callable never retries a write itself
  })

  test('a Host application that met a 5xx is OUTCOME_UNKNOWN', async () => {
    behaviour = { kind: 'reply', status: 503, raw: '<html>upstream</html>' }
    const e = await refusal(applyHost())
    expect(e && e.code).toBe('deadline-exceeded')
    expect(e.details && e.details.code).toBe('OUTCOME_UNKNOWN')
  })

  test('a 500 with a JSON body is OUTCOME_UNKNOWN too', async () => {
    behaviour = { kind: 'reply', status: 500, body: { detail: 'Internal Server Error' } }
    const e = await refusal(applyAgency())
    expect(e && e.code).toBe('deadline-exceeded')
    expect(e.details && e.details.code).toBe('OUTCOME_UNKNOWN')
  })

  test('a recharge whose request could not be delivered is OUTCOME_UNKNOWN', async () => {
    behaviour = { kind: 'unreachable' }
    const e = await refusal(recharge({ requestId: 'req-0123456789' }))
    expect(e && e.code).toBe('deadline-exceeded')
    expect(e.details && e.details.code).toBe('OUTCOME_UNKNOWN')
  })
})

describe('a read keeps its old answer — repeating it is harmless', () => {
  test('myPartnerApplications timing out is unavailable, with no OUTCOME_UNKNOWN', async () => {
    behaviour = { kind: 'timeout' }
    const e = await refusal(readMine())
    expect(e && e.code).toBe('unavailable')
    expect(!e.details || e.details.code !== 'OUTCOME_UNKNOWN').toBe(true)
  })
  test('a read that met a 503 is unavailable', async () => {
    behaviour = { kind: 'reply', status: 503, raw: '' }
    const e = await refusal(readMine())
    expect(e && e.code).toBe('unavailable')
  })
})

describe('refusals the API explains keep the API sentence', () => {
  test('409 is failed-precondition with the API sentence (was: "could not be reached")', async () => {
    behaviour = { kind: 'reply', status: 409, body: { detail: 'This request was already filed.' } }
    const e = await refusal(applyAgency())
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('This request was already filed.')
  })
  test('422 is invalid-argument with a sentence for a person, not the field list', async () => {
    behaviour = { kind: 'reply', status: 422, body: { detail: [{ loc: ['body', 'payment_method'], msg: 'too short' }] } }
    const e = await refusal(recharge({ paymentMethod: 'x' }))
    expect(e && e.code).toBe('invalid-argument')
    expect(/loc|payment_method/.test(e.message)).toBe(false)
  })
  test('400 is still failed-precondition with the API sentence', async () => {
    behaviour = { kind: 'reply', status: 400, body: { detail: 'Your Host application is already with a reviewer.' } }
    const e = await refusal(applyHost())
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('Your Host application is already with a reviewer.')
  })
  test('403 is still internal, never the credential problem itself', async () => {
    behaviour = { kind: 'reply', status: 403, body: { detail: 'bad service key' } }
    const e = await refusal(applyAgency())
    expect(e && e.code).toBe('internal')
    expect(/service key/.test(e.message)).toBe(false)
  })
  test('a success is unchanged', async () => {
    const r = await applyAgency()
    expect(r.id).toBe('APP-1')
  })
})

describe('the recharge request id', () => {
  test('is forwarded as client_request_id when the app sends one', async () => {
    behaviour = { kind: 'reply', status: 201, body: { id: 'R1', status: 'pending' } }
    await recharge({ requestId: 'req-0123456789' })
    expect(sent.length).toBe(1)
    expect(sent[0].url).toBe(`${BASE}/api/partner-ops/recharges`)
    expect(sent[0].body.client_request_id).toBe('req-0123456789')
    expect(sent[0].body.buyer_uid).toBe('U1')
  })
  test('is left out for an older app that sends none (the API behaves as before)', async () => {
    behaviour = { kind: 'reply', status: 201, body: { id: 'R1', status: 'pending' } }
    await recharge()
    expect('client_request_id' in sent[0].body).toBe(false)
  })
  for (const bad of ['short', 'has space in it', 'x'.repeat(65), 'semi;colon!!']) {
    test(`a malformed id ${JSON.stringify(bad.slice(0, 20))} is refused before anything is sent`, async () => {
      const e = await refusal(recharge({ requestId: bad }))
      expect(e && e.code).toBe('invalid-argument')
      expect(sent.length).toBe(0)
    })
  }
  test('the same id twice is sent twice unchanged — the API, not the callable, recognises the repeat', async () => {
    behaviour = { kind: 'reply', status: 201, body: { id: 'R1', status: 'pending' } }
    await recharge({ requestId: 'req-0123456789' })
    await recharge({ requestId: 'req-0123456789' })
    expect(sent.map((s) => s.body.client_request_id)).toEqual(['req-0123456789', 'req-0123456789'])
  })
})

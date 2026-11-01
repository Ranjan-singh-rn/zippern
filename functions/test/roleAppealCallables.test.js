/**
 * C2 (B05) — `submitRoleAppeal` and `myRoleAppeals`, executed.
 *
 * The reinstatement request for a revoked role rides the same bridge as the
 * "Join as …" callables (`partnerApplicationCallables.test.js` pins their
 * source): authenticated, the uid taken from the TOKEN and never from `data`,
 * the partner-registration key presented, and nothing decided here beyond the
 * shape of the input — kind is one of host | agency | sub_agency | seller and
 * the statement is 20–2000 characters.
 *
 * `fetch` is replaced with a recorder before anything runs, and the API origin
 * is a `.test` name, so no request can leave this process.
 *
 * Run:  node --test test/roleAppealCallables.test.js
 */

const { test, describe, beforeEach } = require('node:test')
const { expect } = require('./expect')

const { installFakeFirestore } = require('./fakeFirestore')
installFakeFirestore()

const KEY = 'k'.repeat(40)
const BASE = 'https://api.zipper.test'

// ── the API, as a recorder ───────────────────────────────────────────────────
const sent = []
let reply = { status: 200, body: {} }
globalThis.fetch = async (url, init) => {
  sent.push({
    url: String(url),
    method: init && init.method,
    headers: (init && init.headers) || {},
    body: init && init.body ? JSON.parse(init.body) : undefined,
  })
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: async () => JSON.stringify(reply.body),
  }
}

const index = require('../lib/index')

const ctx = (uid) => (uid ? { auth: { uid, token: { auth_time: 2000 } } } : {})
const submit = (data, uid = 'U1') => index.submitRoleAppeal.run(data, ctx(uid))
const mine = (data, uid = 'U1') => index.myRoleAppeals.run(data, ctx(uid))
const STATEMENT = 'I was revoked by mistake; my agency confirms I was active.'

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

beforeEach(() => {
  sent.length = 0
  reply = { status: 200, body: {} }
  process.env.ZIPPER_PARTNER_REGISTRATION_KEY = KEY
  process.env.ZIPPER_API_BASE_URL = BASE
})

describe('both are exported from the entry point, like every other callable', () => {
  test('submitRoleAppeal and myRoleAppeals', () => {
    expect(typeof index.submitRoleAppeal.run).toBe('function')
    expect(typeof index.myRoleAppeals.run).toBe('function')
  })
})

describe('submitRoleAppeal — input shape', () => {
  test('unauthenticated is refused before anything is sent', async () => {
    const e = await refusal(submit({ kind: 'host', statement: STATEMENT }, null))
    expect(e && e.code).toBe('unauthenticated')
    expect(sent.length).toBe(0)
  })

  for (const kind of ['', 'admin', 'Host', 'sub-agency', 'owner', undefined]) {
    test(`kind ${JSON.stringify(kind)} is refused`, async () => {
      const e = await refusal(submit({ kind, statement: STATEMENT }))
      expect(e && e.code).toBe('invalid-argument')
      expect(sent.length).toBe(0)
    })
  }

  test('19 characters is refused; 20 is accepted', async () => {
    const short = await refusal(submit({ kind: 'host', statement: 'x'.repeat(19) }))
    expect(short && short.code).toBe('invalid-argument')
    // Padding does not count: what is sent is the trimmed statement.
    const padded = await refusal(submit({ kind: 'host', statement: `   ${'x'.repeat(19)}   ` }))
    expect(padded && padded.code).toBe('invalid-argument')
    expect(sent.length).toBe(0)
    await submit({ kind: 'host', statement: 'x'.repeat(20) })
    expect(sent.length).toBe(1)
  })

  test('2000 characters is accepted; 2001 is refused', async () => {
    await submit({ kind: 'seller', statement: 'y'.repeat(2000) })
    expect(sent.length).toBe(1)
    const long = await refusal(submit({ kind: 'seller', statement: 'y'.repeat(2001) }))
    expect(long && long.code).toBe('invalid-argument')
    expect(sent.length).toBe(1)
  })

  test('every one of the four kinds is accepted', async () => {
    for (const kind of ['host', 'agency', 'sub_agency', 'seller']) await submit({ kind, statement: STATEMENT })
    expect(sent.map((s) => s.body.kind)).toEqual(['host', 'agency', 'sub_agency', 'seller'])
  })
})

describe('submitRoleAppeal — the uid is the token\'s, and the API decides', () => {
  test('POST /api/partner-ops/role-appeals with {uid, kind, statement}; a uid in data is ignored', async () => {
    reply = { status: 200, body: { appeal: { id: 'ra_1', status: 'pending', kind: 'agency' } } }
    const r = await submit({ kind: 'agency', statement: `  ${STATEMENT}  `, uid: 'VICTIM', applicant_uid: 'VICTIM' })
    expect(sent.length).toBe(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].url).toBe(`${BASE}/api/partner-ops/role-appeals`)
    expect(sent[0].headers['X-Service-Key']).toBe(KEY)
    expect(sent[0].body).toEqual({ uid: 'U1', kind: 'agency', statement: STATEMENT })
    expect(r.appeal.id).toBe('ra_1')
  })

  test('an API refusal reaches the person as failed-precondition with the API\'s sentence', async () => {
    reply = { status: 400, body: { detail: 'There is no revoked Agency role on this account.' } }
    const e = await refusal(submit({ kind: 'agency', statement: STATEMENT }))
    expect(e && e.code).toBe('failed-precondition')
    expect(e.message).toBe('There is no revoked Agency role on this account.')
  })

  test('not configured: refused as unavailable, and nothing is sent', async () => {
    delete process.env.ZIPPER_PARTNER_REGISTRATION_KEY
    const e = await refusal(submit({ kind: 'host', statement: STATEMENT }))
    expect(e && e.code).toBe('internal')
    expect(sent.length).toBe(0)
  })
})

describe('myRoleAppeals — the caller\'s own requests only', () => {
  test('GET /api/partner-ops/role-appeals/of/{token uid}; a uid in data is ignored', async () => {
    reply = { status: 200, body: { appeals: [{ id: 'ra_2' }, { id: 'ra_1' }] } }
    const r = await mine({ uid: 'VICTIM' })
    expect(sent.length).toBe(1)
    expect(sent[0].method).toBe('GET')
    expect(sent[0].url).toBe(`${BASE}/api/partner-ops/role-appeals/of/U1`)
    expect(sent[0].body).toBe(undefined)
    expect(r).toEqual({ appeals: [{ id: 'ra_2' }, { id: 'ra_1' }] })
  })

  test('the uid is path-encoded', async () => {
    await mine({}, 'a/b c')
    expect(sent[0].url).toBe(`${BASE}/api/partner-ops/role-appeals/of/a%2Fb%20c`)
  })

  test('an unexpected body shape is an empty list, not a crash', async () => {
    reply = { status: 200, body: { something: 'else' } }
    expect(await mine({})).toEqual({ appeals: [] })
  })

  test('unauthenticated is refused before anything is sent', async () => {
    const e = await refusal(mine({}, null))
    expect(e && e.code).toBe('unauthenticated')
    expect(sent.length).toBe(0)
  })
})

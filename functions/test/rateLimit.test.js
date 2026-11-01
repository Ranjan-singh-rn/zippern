/**
 * F-8 (audit 2026-11-01) — abuse limits on the four unauthenticated callables,
 * and the App Check plumbing behind ENFORCE_APP_CHECK.
 *
 *   * `quickLoginChallenge`, `redeemQuickLogin`, `submitAccountAppeal` and
 *     `claimGuestIdentity` count every call against `rateLimits/{bucket}`
 *     per device and per client address, and answer `resource-exhausted`
 *     (`RATE_LIMITED`, with `retryAfterMs`) once a window's budget is spent;
 *   * a refused call reads and writes nothing else (no challenge consumed,
 *     no binding touched), and a legitimate client never meets the budget;
 *   * the bucket id and document carry hashes, never the raw address or id;
 *   * a Firestore failure in the limiter allows the call (fail open);
 *   * `sweepQuickLoginTokens` deletes expired buckets;
 *   * with `ENFORCE_APP_CHECK=true` a call without a verified App Check
 *     payload is `unauthenticated` (`APP_CHECK_REQUIRED`); with the flag off
 *     (the default) nothing changes.
 *
 * Run:  node --test test/rateLimit.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore, Timestamp } = require('./fakeFirestore')

let db = installFakeFirestore()
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => ({ uid, providerData: [] }),
    createCustomToken: async (uid) => `t-${uid}`,
  }),
})

const RL = require('../lib/rateLimit')
const QL = require('../lib/quickLogin')
const ID = require('../lib/identity')

const IP_A = '203.0.113.7'
const IP_B = '198.51.100.9'
/** A window boundary for both the 1-minute and the 10-minute policies. */
const BASE = 1_700_000_400_000
const from = (ip, extra = {}) => ({ rawRequest: { headers: { 'x-forwarded-for': ip } }, ...extra })
async function refusal(p) { try { await p } catch (e) { return e } return null }
const detail = (e) => (e && e.details ? e.details.code : undefined)

/** Run `fn` with the clock pinned at `ms`. */
async function at(ms, fn) {
  const real = Date.now
  Date.now = () => ms
  try { return await fn() } finally { Date.now = real }
}

beforeEach(() => { db._docs.clear() })

// ══ pure ═════════════════════════════════════════════════════════════════════

describe('windowDecision / windowStartOf — pure', () => {
  const policy = { limit: 3, windowMs: 60_000 }
  test('under the limit is allowed; at the limit is refused until the window turns over', () => {
    const now = BASE + 30_000                       // 30 s into a minute window
    expect(RL.windowDecision(0, policy, now).allowed).toBe(true)
    expect(RL.windowDecision(2, policy, now).allowed).toBe(true)
    const d = RL.windowDecision(3, policy, now)
    expect(d.allowed).toBe(false)
    expect(d.retryAfterMs).toBe(30_000)
    expect(RL.windowDecision(99, policy, now).allowed).toBe(false)
  })
  test('a missing or malformed count is zero — a first call is never refused', () => {
    for (const v of [undefined, null, '', 'x', NaN, -5, {}, []]) {
      expect(RL.windowDecision(v, policy, BASE).allowed).toBe(true)
    }
  })
  test('the window start is aligned to the policy', () => {
    expect(RL.windowStartOf(BASE + 30_000, policy)).toBe(BASE)
    expect(RL.windowStartOf(BASE + 59_999, policy)).toBe(BASE)
    expect(RL.windowStartOf(BASE + 60_000, policy)).toBe(BASE + 60_000)
  })
})

describe('clientIpOf — the address the infrastructure vouches for', () => {
  test('the LAST X-Forwarded-For entry wins; what the client prepended does not', () => {
    expect(RL.clientIpOf({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.7' } })).toBe('203.0.113.7')
    expect(RL.clientIpOf({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7')
    expect(RL.clientIpOf({ headers: { 'x-forwarded-for': ['10.0.0.1', '203.0.113.7'] } })).toBe('203.0.113.7')
  })
  test('falls back to req.ip, then to nothing', () => {
    expect(RL.clientIpOf({ headers: {}, ip: '203.0.113.7' })).toBe('203.0.113.7')
    expect(RL.clientIpOf({})).toBe('')
    expect(RL.clientIpOf(undefined)).toBe('')
  })
})

describe('bucketId — hashes only', () => {
  test('neither the address nor the device id appears in the id', () => {
    const id = RL.bucketId('redeemQuickLogin', 'ip', IP_A, BASE)
    expect(id.startsWith('redeemQuickLogin:ip:')).toBe(true)
    expect(id).not.toContain(IP_A)
    expect(id.endsWith(`:${BASE}`)).toBe(true)
    const dev = RL.bucketId('redeemQuickLogin', 'dev', 'ANDROID-ID-123', BASE)
    expect(dev).not.toContain('ANDROID-ID-123')
    expect(RL.bucketId('x', 'ip', IP_A, 1)).not.toBe(RL.bucketId('x', 'ip', IP_B, 1))
  })
})

describe('the policies are the documented conservative defaults', () => {
  test('every unauthenticated callable has one; nothing else does', () => {
    expect(Object.keys(RL.RATE_LIMIT_POLICIES).sort()).toEqual([
      'claimGuestIdentity', 'quickLoginChallenge', 'redeemQuickLogin', 'submitAccountAppeal',
    ])
    expect(RL.RATE_LIMIT_POLICIES.quickLoginChallenge).toEqual({ perIp: { limit: 120, windowMs: 60_000 } })
    expect(RL.RATE_LIMIT_POLICIES.redeemQuickLogin.perDevice).toEqual({ limit: 10, windowMs: 60_000 })
    expect(RL.RATE_LIMIT_POLICIES.submitAccountAppeal.perDevice).toEqual({ limit: 5, windowMs: 600_000 })
    expect(RL.RATE_LIMIT_POLICIES.claimGuestIdentity.perIp).toEqual({ limit: 60, windowMs: 60_000 })
  })
})

// ══ the callables ════════════════════════════════════════════════════════════

describe('quickLoginChallenge — per address', () => {
  test('120 in a minute from one address, then resource-exhausted; another address is unaffected', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 120; i++) {
        const c = await QL.quickLoginChallenge.run({}, from(IP_A))
        expect(typeof c.challengeId).toBe('string')
      }
      const e = await refusal(QL.quickLoginChallenge.run({}, from(IP_A)))
      expect(e && e.code).toBe('resource-exhausted')
      expect(detail(e)).toBe('RATE_LIMITED')
      expect(e.details.retryAfterMs).toBe(60_000)
      expect(db.count('quickLoginChallenges')).toBe(120)       // the refused call wrote nothing
      const other = await QL.quickLoginChallenge.run({}, from(IP_B))
      expect(typeof other.challengeId).toBe('string')
    })
  })

  test('the bucket document holds a count and hashes, never the address', async () => {
    await at(BASE, async () => {
      await QL.quickLoginChallenge.run({}, from(IP_A))
      await QL.quickLoginChallenge.run({}, from(IP_A))
      const buckets = db.all('rateLimits')
      expect(buckets).toHaveLength(1)
      expect(buckets[0].count).toBe(2)
      expect(buckets[0].scope).toBe('quickLoginChallenge')
      expect(buckets[0].kind).toBe('ip')
      expect(JSON.stringify(buckets[0])).not.toContain(IP_A)
      expect(buckets[0].expiresAt.toMillis()).toBeGreaterThan(BASE + 24 * 3600 * 1000)
    })
  })

  test('the next window starts a fresh budget', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 120; i++) await QL.quickLoginChallenge.run({}, from(IP_A))
      expect((await refusal(QL.quickLoginChallenge.run({}, from(IP_A)))).code).toBe('resource-exhausted')
    })
    await at(BASE + 60_000, async () => {
      const c = await QL.quickLoginChallenge.run({}, from(IP_A))
      expect(typeof c.challengeId).toBe('string')
    })
  })

  test('with no address known (the emulator, a test) there is nothing to limit', async () => {
    for (let i = 0; i < 125; i++) await QL.quickLoginChallenge.run({}, {})
    expect(db.count('rateLimits')).toBe(0)
  })
})

describe('redeemQuickLogin — per device and per address, before any read', () => {
  const secret = 'z'.repeat(43)
  test('the 11th attempt from one device in a minute is refused without consuming its challenge', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 10; i++) {
        const e = await refusal(QL.redeemQuickLogin.run({ token: secret, deviceId: 'DEV-1', challengeId: 'none', signature: 'x' }, from(IP_A)))
        expect(e && e.code).toBe('permission-denied')      // an unknown credential, refused on the merits
      }
      const c = await QL.quickLoginChallenge.run({}, from(IP_B))
      const e = await refusal(QL.redeemQuickLogin.run({ token: secret, deviceId: 'DEV-1', challengeId: c.challengeId, signature: 'x' }, from(IP_A)))
      expect(e && e.code).toBe('resource-exhausted')
      expect(detail(e)).toBe('RATE_LIMITED')
      expect(db.read(`quickLoginChallenges/${c.challengeId}`).usedAt).toBe(null)   // not consumed
      // Another device from the same address still has its own budget.
      const other = await refusal(QL.redeemQuickLogin.run({ token: secret, deviceId: 'DEV-2', challengeId: 'none', signature: 'x' }, from(IP_A)))
      expect(other && other.code).toBe('permission-denied')
    })
  })

  test('the address budget bounds a script that rotates device ids', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 60; i++) {
        await refusal(QL.redeemQuickLogin.run({ token: secret, deviceId: `ROT-${i}`, challengeId: 'none', signature: 'x' }, from(IP_A)))
      }
      const e = await refusal(QL.redeemQuickLogin.run({ token: secret, deviceId: 'ROT-NEW', challengeId: 'none', signature: 'x' }, from(IP_A)))
      expect(e && e.code).toBe('resource-exhausted')
    })
  })

  test('a malformed secret is refused for free, before the limiter counts anything', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 30; i++) {
        const e = await refusal(QL.redeemQuickLogin.run({ token: 'short', deviceId: 'DEV-1' }, from(IP_A)))
        expect(e && e.code).toBe('permission-denied')
      }
      expect(db.count('rateLimits')).toBe(0)
    })
  })
})

describe('submitAccountAppeal — five per device per ten minutes', () => {
  const secret = 'y'.repeat(43)
  const statement = 'I believe this restriction was a mistake and I would like a reviewer to look at it.'
  test('the sixth appeal attempt from one device is refused', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 5; i++) {
        const e = await refusal(QL.submitAccountAppeal.run({ token: secret, deviceId: 'DEV-A', challengeId: 'none', signature: 'x', statement }, from(IP_A)))
        expect(e && e.code).toBe('permission-denied')
      }
      const e = await refusal(QL.submitAccountAppeal.run({ token: secret, deviceId: 'DEV-A', challengeId: 'none', signature: 'x', statement }, from(IP_A)))
      expect(e && e.code).toBe('resource-exhausted')
      expect(e.details.retryAfterMs).toBe(600_000)
    })
  })
  test('a statement problem is reported before the limiter counts anything', async () => {
    await at(BASE, async () => {
      const e = await refusal(QL.submitAccountAppeal.run({ token: secret, deviceId: 'DEV-A', statement: 'no' }, from(IP_A)))
      expect(e && e.code).toBe('invalid-argument')
      expect(db.count('rateLimits')).toBe(0)
    })
  })
})

describe('claimGuestIdentity — per device and per address', () => {
  const claim = (deviceId, ip) => ID.claimGuestIdentity.run({ deviceId, deviceSecret: 'q'.repeat(43) }, from(ip))
  test('the 11th claim from one device in a minute is refused and touches no binding', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 10; i++) {
        const r = await claim('DEV-G', IP_A)
        expect(typeof r.status).toBe('string')
      }
      const writes = db.writes
      const e = await refusal(claim('DEV-G', IP_A))
      expect(e && e.code).toBe('resource-exhausted')
      expect(detail(e)).toBe('RATE_LIMITED')
      expect(db.writes).toBe(writes)
    })
  })
  test('sixty claims from one address, whatever the device id, then refused', async () => {
    await at(BASE, async () => {
      for (let i = 0; i < 60; i++) await claim(`DEV-${i}`, IP_A)
      const e = await refusal(claim('DEV-61', IP_A))
      expect(e && e.code).toBe('resource-exhausted')
      const ok = await claim('DEV-61', IP_B)
      expect(typeof ok.status).toBe('string')
    })
  })
})

// ══ failure modes and housekeeping ═══════════════════════════════════════════

describe('the limiter fails OPEN on a Firestore failure', () => {
  const DocRef = db.collection('_probe').doc('_probe').constructor
  const originalGet = DocRef.prototype.get
  afterEach(() => { DocRef.prototype.get = originalGet })

  test('a bucket read that throws allows the call', async () => {
    DocRef.prototype.get = async function patched() {
      if (this.path.startsWith('rateLimits/')) throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 })
      return originalGet.call(this)
    }
    const c = await QL.quickLoginChallenge.run({}, from(IP_A))
    expect(typeof c.challengeId).toBe('string')
  })
})

describe('sweepQuickLoginTokens removes expired buckets', () => {
  test('an expired bucket goes, a live one stays', async () => {
    const now = Date.now()
    db.seed('rateLimits/old', { scope: 'x', kind: 'ip', count: 3, expiresAt: Timestamp.fromMillis(now - 1000) })
    db.seed('rateLimits/live', { scope: 'x', kind: 'ip', count: 3, expiresAt: Timestamp.fromMillis(now + 3_600_000) })
    await ID.sweepQuickLoginTokens.run({}, {})
    expect(db.has('rateLimits/old')).toBe(false)
    expect(db.has('rateLimits/live')).toBe(true)
  })
})

// ══ App Check plumbing ═══════════════════════════════════════════════════════

describe('ENFORCE_APP_CHECK — off by default, enforced when set', () => {
  afterEach(() => { delete process.env.ENFORCE_APP_CHECK })

  test('appCheckRefusal / enforcingAppCheck — pure', () => {
    delete process.env.ENFORCE_APP_CHECK
    expect(RL.enforcingAppCheck()).toBe(false)
    expect(RL.appCheckRuntimeOptions()).toEqual({ enforceAppCheck: false })
    process.env.ENFORCE_APP_CHECK = 'true'
    expect(RL.enforcingAppCheck()).toBe(true)
    expect(RL.appCheckRuntimeOptions()).toEqual({ enforceAppCheck: true })
    expect(RL.appCheckRefusal(undefined, true)).toBe(true)
    expect(RL.appCheckRefusal({ appId: '1:2:android:3' }, true)).toBe(false)
    expect(RL.appCheckRefusal(undefined, false)).toBe(false)
  })

  test('flag off: a call with no App Check payload proceeds', async () => {
    delete process.env.ENFORCE_APP_CHECK
    const c = await QL.quickLoginChallenge.run({}, from(IP_A))
    expect(typeof c.challengeId).toBe('string')
  })

  test('flag on: no payload → unauthenticated APP_CHECK_REQUIRED on all four; a verified payload proceeds', async () => {
    process.env.ENFORCE_APP_CHECK = 'true'
    const secret = 'w'.repeat(43)
    const calls = [
      () => QL.quickLoginChallenge.run({}, from(IP_A)),
      () => QL.redeemQuickLogin.run({ token: secret, deviceId: 'D' }, from(IP_A)),
      () => QL.submitAccountAppeal.run({ token: secret, deviceId: 'D', statement: 'I believe this restriction was a mistake and I would like a reviewer to look.' }, from(IP_A)),
      () => ID.claimGuestIdentity.run({ deviceId: 'D', deviceSecret: secret }, from(IP_A)),
    ]
    for (const c of calls) {
      const e = await refusal(c())
      expect(e && e.code).toBe('unauthenticated')
      expect(detail(e)).toBe('APP_CHECK_REQUIRED')
    }
    expect(db.count('quickLoginChallenges')).toBe(0)
    const ok = await QL.quickLoginChallenge.run({}, from(IP_A, { app: { appId: '1:2:android:3', token: {} } }))
    expect(typeof ok.challengeId).toBe('string')
  })
})

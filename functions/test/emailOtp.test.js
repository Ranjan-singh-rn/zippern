/**
 * UGP-C — binding an email by a one-time code.
 *
 * Runs the REAL callables from lib/ against the in-memory Firestore, a scripted
 * Firebase Auth and a captured mail transport. What is pinned:
 *
 *   * the code is mailed, never stored (only a salted HMAC is), and the reply
 *     never reveals whether the address belongs to anybody;
 *   * resend cooldown, hourly caps per account and per address, 5 attempts,
 *     expiry, single use, and an idempotent retry after a lost response;
 *   * the bind goes through `bindContactCore` — no replacement, a live holder
 *     refuses, an Auth holder refuses, a permanently deactivated holder is
 *     released — and lands on the CALLER'S uid with `emailVerified: true`;
 *   * nothing is left half-bound when the Auth write fails;
 *   * an anonymous session is handed a same-uid custom token (D21);
 *   * `isGuestAccount` stops calling a code-bound account a guest.
 *
 * Run:  node --test test/emailOtp.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const admin = require('firebase-admin')
const { installFakeFirestore } = require('./fakeFirestore')

const db = installFakeFirestore()

// ── A scripted Firebase Auth ────────────────────────────────────────────────
const authState = {
  records: new Map(),          // uid → { uid, email, emailVerified, phoneNumber, providerData }
  updateError: null,           // an error to throw from updateUser once
  updates: [],
  minted: [],
}
function resetAuth() {
  authState.records.clear()
  authState.updateError = null
  authState.updates = []
  authState.minted = []
}
Object.defineProperty(admin, 'auth', {
  configurable: true, writable: true,
  value: () => ({
    getUser: async (uid) => authState.records.get(uid) ?? { uid, providerData: [] },
    getUserByEmail: async (email) => {
      for (const r of authState.records.values()) {
        if (String(r.email ?? '').toLowerCase() === email) return r
      }
      const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e
    },
    updateUser: async (uid, patch) => {
      if (authState.updateError) { const e = authState.updateError; authState.updateError = null; throw e }
      authState.updates.push({ uid, ...patch })
      const r = authState.records.get(uid) ?? { uid, providerData: [] }
      authState.records.set(uid, { ...r, ...patch })
    },
    createCustomToken: async (uid) => { authState.minted.push(uid); return `custom-${uid}` },
    revokeRefreshTokens: async () => undefined,
  }),
})

const OTP = require('../lib/emailOtp')
const ID = require('../lib/identity')
const MAIL = require('../lib/mail')

// ── Captured mail ───────────────────────────────────────────────────────────
let outbox = []
let mailFails = false
MAIL.setMailTransportForTests(async (m) => {
  if (mailFails) throw new Error('provider down')
  outbox.push(m)
})
const lastCode = () => {
  const m = outbox[outbox.length - 1]
  return m ? (m.text.match(/code is (\d{6})/) || [])[1] : undefined
}

// ── Clock ───────────────────────────────────────────────────────────────────
const realNow = Date.now
let clock = 1_800_000_000_000
const advance = (ms) => { clock += ms }

const UID = 'G1'
const ANON = { auth_time: 2000, firebase: { sign_in_provider: 'anonymous' } }
const PHONE = { auth_time: 2000, phone_number: '+919800000001', firebase: { sign_in_provider: 'phone' } }
const ctx = (token = ANON, uid = UID) => ({ auth: { uid, token } })
const request = (email, token, uid) => OTP.requestEmailBindCode.run({ email }, ctx(token, uid))
const verify = (email, code, token, uid) => OTP.verifyEmailBindCode.run({ email, code }, ctx(token, uid))

async function refusal(p) {
  try { await p } catch (e) { return e }
  return null
}

beforeEach(() => {
  db._docs.clear()
  resetAuth()
  outbox = []
  mailFails = false
  clock = 1_800_000_000_000
  Date.now = () => clock
  db.seed(`users/${UID}`, { name: 'Guest abc', diamonds: 40 })
})
afterEach(() => { Date.now = realNow })

// ══════════════════════════════════════════════════════════════════════════
describe('pure policy', () => {
  test('validEmail accepts ordinary addresses and normalises case', () => {
    expect(OTP.validEmail('  Person@Example.COM ')).toBe('person@example.com')
    for (const bad of ['', 'a', 'no-at.example.com', 'a@b', 'a@@b.com', 'a b@c.com', 'a@.com', 'a@b..com', 'a@b.com.']) {
      expect(OTP.validEmail(bad)).toBe('')
    }
  })
  test('maskEmail hides most of the address', () => {
    const m = OTP.maskEmail('soumya@gmail.com')
    expect(m.startsWith('s')).toBe(true)
    expect(m.includes('soumya')).toBe(false)
    expect(m.endsWith('.com')).toBe(true)
  })
  test('the stored digest is not the code, and only the right code matches', () => {
    const salt = OTP.newSalt()
    const d = OTP.digestCode('123456', salt)
    expect(d.includes('123456')).toBe(false)
    expect(OTP.codeMatches('123456', salt, d)).toBe(true)
    expect(OTP.codeMatches('123457', salt, d)).toBe(false)
    expect(OTP.codeMatches('123456', OTP.newSalt(), d)).toBe(false)
  })
  test('generateCode is six digits', () => {
    for (let i = 0; i < 50; i++) expect(/^\d{6}$/.test(OTP.generateCode())).toBe(true)
  })
  test('decideSend: cooldown, account cap, address cap', () => {
    const now = 10_000_000
    expect(OTP.decideSend({ nowMs: now }).ok).toBe(true)
    const cd = OTP.decideSend({ nowMs: now, challenge: { sentAtMs: now - 10_000 } })
    expect(cd.ok).toBe(false); expect(cd.reason).toBe('cooldown')
    const full = { windowStartMs: now - 1000, count: OTP.OTP_POLICY.maxSendsPerAccountPerWindow }
    expect(OTP.decideSend({ nowMs: now, accountWindow: full }).reason).toBe('rate_limited')
    expect(OTP.decideSend({ nowMs: now, addressWindow: full }).reason).toBe('rate_limited')
    const old = { windowStartMs: now - OTP.OTP_POLICY.windowMs - 1, count: 99 }
    expect(OTP.decideSend({ nowMs: now, accountWindow: old, addressWindow: old }).ok).toBe(true)
  })
  test('decideVerify covers every branch', () => {
    const salt = 's1'
    const ch = { emailKey: 'a@b.co', salt, digest: OTP.digestCode('111111', salt), expiresAtMs: 5000, attempts: 0 }
    const v = (over, p = {}) => OTP.decideVerify({ nowMs: 1000, email: 'a@b.co', code: '111111', challenge: { ...ch, ...over }, ...p })
    expect(OTP.decideVerify({ nowMs: 1, email: 'a@b.co', code: '1' }).result).toBe('no_code')
    expect(v({}, { email: 'other@b.co' }).result).toBe('no_code')
    expect(v({ voided: true }).result).toBe('no_code')
    expect(v({}).result).toBe('ok')
    expect(v({}, { code: '222222' }).result).toBe('wrong')
    expect(v({}, { code: '222222' }).attemptsLeft).toBe(OTP.OTP_POLICY.maxAttempts - 1)
    expect(v({ attempts: OTP.OTP_POLICY.maxAttempts }).result).toBe('locked')
    expect(v({}, { nowMs: 6000 }).result).toBe('expired')
    expect(v({ consumedAtMs: 900 }).result).toBe('replay')
    expect(v({ consumedAtMs: 900 }, { code: '222222' }).result).toBe('used')
    expect(v({ consumedAtMs: 900 }, { nowMs: 900 + OTP.OTP_POLICY.replayWindowMs + 1 }).result).toBe('used')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('requestEmailBindCode', () => {
  test('mails a code, stores only its digest, answers with a masked address', async () => {
    const r = await request('Person@Example.com')
    expect(r.status).toBe('sent')
    expect(r.email.includes('person')).toBe(false)
    expect(outbox.length).toBe(1)
    expect(outbox[0].to).toBe('person@example.com')
    const code = lastCode()
    expect(/^\d{6}$/.test(code)).toBe(true)
    const stored = db.read(`emailOtpChallenges/${UID}`)
    expect(stored.emailKey).toBe('person@example.com')
    expect(JSON.stringify(stored).includes(code)).toBe(false)
    expect(stored.attempts).toBe(0)
    // the event never carries the address
    const ev = db.all('authEvents').find((e) => e.event === 'EMAIL_BIND_CODE_SENT')
    expect(ev.emailDomain).toBe('example.com')
    expect(JSON.stringify(ev).includes('person@')).toBe(false)
  })

  test('does not reveal whether the address belongs to another account', async () => {
    db.seed('users/OTHER', { name: 'o', email: 'taken@example.com' })
    authState.records.set('OTHER', { uid: 'OTHER', email: 'taken@example.com', emailVerified: true, providerData: [] })
    const r = await request('taken@example.com')
    expect(r.status).toBe('sent')
  })

  test('a second request inside 60 s is refused with a wait; after it, the new code voids the old', async () => {
    await request('p@example.com')
    const first = lastCode()
    const e = await refusal(request('p@example.com'))
    expect(e.code).toBe('resource-exhausted')
    expect(e.details.reason).toBe('cooldown')
    expect(e.details.retryAfterSec > 0).toBe(true)
    advance(61_000)
    await request('p@example.com')
    const second = lastCode()
    if (first !== second) {
      const old = await refusal(verify('p@example.com', first))
      expect(old.code).toBe('invalid-argument')
    }
  })

  test('five sends an hour per account, then rate-limited', async () => {
    for (let i = 0; i < OTP.OTP_POLICY.maxSendsPerAccountPerWindow; i++) {
      await request(`p${i}@example.com`)
      advance(61_000)
    }
    const e = await refusal(request('p9@example.com'))
    expect(e.code).toBe('resource-exhausted')
    expect(e.details.reason).toBe('rate_limited')
  })

  test('five sends an hour per ADDRESS across accounts (no inbox flooding)', async () => {
    for (let i = 0; i < OTP.OTP_POLICY.maxSendsPerAddressPerWindow; i++) {
      db.seed(`users/U${i}`, { name: 'x' })
      await request('victim@example.com', ANON, `U${i}`)
    }
    db.seed('users/U9', { name: 'x' })
    const e = await refusal(request('victim@example.com', ANON, 'U9'))
    expect(e.details.reason).toBe('rate_limited')
  })

  test('refuses a malformed address and the observer address', async () => {
    expect((await refusal(request('not-an-email'))).code).toBe('invalid-argument')
    expect((await refusal(request('314zipper@gmail.com'))).code).toBe('permission-denied')
    expect(outbox.length).toBe(0)
  })

  test('refuses to REPLACE an email already on the account', async () => {
    db.seed(`users/${UID}`, { name: 'g', email: 'old@example.com' })
    const e = await refusal(request('new@example.com'))
    expect(e.code).toBe('failed-precondition')
    expect(e.details.reason).toBe('contact_replacement_refused')
    expect(outbox.length).toBe(0)
  })

  test('says "already bound" for the address already verified on this account', async () => {
    db.seed(`users/${UID}`, { name: 'g', email: 'me@example.com' })
    authState.records.set(UID, { uid: UID, email: 'me@example.com', emailVerified: true, providerData: [] })
    const r = await request('me@example.com')
    expect(r.status).toBe('already_bound')
    expect(outbox.length).toBe(0)
  })

  test('a mail failure says so and voids the challenge', async () => {
    mailFails = true
    const e = await refusal(request('p@example.com'))
    expect(e.code).toBe('unavailable')
    expect(db.read(`emailOtpChallenges/${UID}`).voided).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('verifyEmailBindCode', () => {
  test('the right code binds the address to the SAME uid, verified on Auth', async () => {
    await request('person@example.com')
    const r = await verify('person@example.com', lastCode())
    expect(r.status).toBe('bound')
    expect(db.read(`users/${UID}`).email).toBe('person@example.com')
    expect(db.read(`users/${UID}`).diamonds).toBe(40) // the guest's data is untouched
    expect(authState.updates.length).toBe(1)
    expect(authState.updates[0].uid).toBe(UID)
    expect(authState.updates[0].email).toBe('person@example.com')
    expect(authState.updates[0].emailVerified).toBe(true)
    const ev = db.all('authEvents').find((e) => e.event === 'EMAIL_BOUND')
    expect(ev.uid).toBe(UID)
    expect(JSON.stringify(ev).includes('person@')).toBe(false)
  })

  test('an anonymous session gets a same-uid custom token; a phone session does not', async () => {
    await request('a@example.com')
    const r = await verify('a@example.com', lastCode(), ANON)
    expect(r.customToken).toBe(`custom-${UID}`)
    expect(authState.minted).toEqual([UID])

    db.seed('users/P1', { name: 'p' })
    await request('b@example.com', PHONE, 'P1')
    const p = await verify('b@example.com', lastCode(), PHONE, 'P1')
    expect(p.status).toBe('bound')
    expect(p.customToken).toBe(undefined)
  })

  test('a wrong code is counted; the fifth wrong code locks the challenge', async () => {
    await request('p@example.com')
    const right = lastCode()
    const wrong = right === '000000' ? '111111' : '000000'
    const first = await refusal(verify('p@example.com', wrong))
    expect(first.code).toBe('invalid-argument')
    expect(first.details.attemptsLeft).toBe(OTP.OTP_POLICY.maxAttempts - 1)
    expect(db.read(`emailOtpChallenges/${UID}`).attempts).toBe(1)
    for (let i = 1; i < OTP.OTP_POLICY.maxAttempts; i++) await refusal(verify('p@example.com', wrong))
    const locked = await refusal(verify('p@example.com', right))
    expect(locked.code).toBe('resource-exhausted')
    expect(locked.details.reason).toBe('locked')
    expect(db.read(`users/${UID}`).email).toBe(undefined)
  })

  test('an expired code is refused', async () => {
    await request('p@example.com')
    advance(OTP.OTP_POLICY.ttlMs + 1)
    const e = await refusal(verify('p@example.com', lastCode()))
    expect(e.code).toBe('deadline-exceeded')
  })

  test('a code for a different address is refused', async () => {
    await request('p@example.com')
    const e = await refusal(verify('q@example.com', lastCode()))
    expect(e.details.reason).toBe('no_code')
  })

  test('a retry of the same code after success is idempotent (lost response)', async () => {
    await request('p@example.com')
    const code = lastCode()
    await verify('p@example.com', code)
    const again = await verify('p@example.com', code)
    expect(again.status).toBe('bound')
    expect(db.read(`users/${UID}`).email).toBe('p@example.com')
  })

  test('a LIVE holder refuses the bind; nothing is written', async () => {
    db.seed('users/OTHER', { name: 'o', email: 'taken@example.com', accountState: 'active' })
    await request('taken@example.com')
    const e = await refusal(verify('taken@example.com', lastCode()))
    expect(e.code).toBe('already-exists')
    expect(e.details.reason).toBe('active_holder')
    expect(db.read(`users/${UID}`).email).toBe(undefined)
    expect(authState.updates.length).toBe(0)
    expect(db.read('users/OTHER').email).toBe('taken@example.com')
  })

  test('an address on ANOTHER Firebase Auth account (e.g. a CRM login) is refused', async () => {
    authState.records.set('CRM1', { uid: 'CRM1', email: 'crm@example.com', emailVerified: true, providerData: [{ providerId: 'password' }] })
    await request('crm@example.com')
    const e = await refusal(verify('crm@example.com', lastCode()))
    expect(e.code).toBe('already-exists')
    expect(db.read(`users/${UID}`).email).toBe(undefined)
    expect(authState.updates.length).toBe(0)
  })

  test('a permanently deactivated holder is released, with a record', async () => {
    db.seed('users/DEAD', { name: 'd', email: 'old@example.com', accountState: 'permanently_deactivated' })
    await request('old@example.com')
    const r = await verify('old@example.com', lastCode())
    expect(r.releasedFrom).toEqual(['DEAD'])
    expect(db.read('users/DEAD').email).toBe('')
    expect(db.read(`users/${UID}`).email).toBe('old@example.com')
    expect(db.count('identityReleases')).toBe(1)
  })

  test('an Auth collision on write takes the document write back', async () => {
    await request('race@example.com')
    const err = new Error('exists'); err.code = 'auth/email-already-exists'
    authState.updateError = err
    const e = await refusal(verify('race@example.com', lastCode()))
    expect(e.code).toBe('already-exists')
    expect(db.read(`users/${UID}`).email).toBe('')
  })

  test('a transient Auth failure leaves nothing bound, and the same code then succeeds', async () => {
    await request('p@example.com')
    const code = lastCode()
    authState.updateError = new Error('timeout')
    const e = await refusal(verify('p@example.com', code))
    expect(e.code).toBe('unavailable')
    expect(db.read(`users/${UID}`).email).toBe('')
    const r = await verify('p@example.com', code)
    expect(r.status).toBe('bound')
    expect(db.read(`users/${UID}`).email).toBe('p@example.com')
  })

  test('a malformed code is refused before anything is read', async () => {
    const e = await refusal(verify('p@example.com', '12'))
    expect(e.code).toBe('invalid-argument')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('review fixes — the Auth record, cumulative limits, folding, replays', () => {
  const P = OTP.OTP_POLICY
  const wrongOf = (c) => (c === '000000' ? '111111' : '000000')

  test('pure: daily caps, the wrong-code lock-out and address folding', () => {
    const now = 50_000_000
    const day = (count) => ({ windowStartMs: now - 1000, count })
    expect(OTP.decideSend({ nowMs: now, accountDay: day(P.maxSendsPerAccountPerDay) }).reason).toBe('rate_limited')
    expect(OTP.decideSend({ nowMs: now, addressDay: day(P.maxSendsPerAddressPerDay) }).reason).toBe('rate_limited')
    expect(OTP.decideSend({ nowMs: now, accountFailures: day(P.maxFailuresPerDay) }).reason).toBe('locked_out')
    // An address is locked only at its own, higher threshold (a stranger feeds that counter).
    expect(OTP.decideSend({ nowMs: now, addressFailures: day(P.maxFailuresPerDay) }).ok).toBe(true)
    expect(OTP.decideSend({ nowMs: now, addressFailures: day(P.maxFailuresPerAddressPerDay) }).reason).toBe('locked_out')
    const old = { windowStartMs: now - P.dayMs - 1, count: 99 }
    expect(OTP.decideSend({ nowMs: now, accountDay: old, accountFailures: old }).ok).toBe(true)
    // the lock-out stops guessing, but a replay of the code that already worked still goes through
    const salt = 's'
    const ch = { emailKey: 'a@b.co', salt, digest: OTP.digestCode('111111', salt), expiresAtMs: now + 5000, attempts: 0 }
    const lock = { accountFailures: day(P.maxFailuresPerDay) }
    expect(OTP.decideVerify({ nowMs: now, email: 'a@b.co', code: '111111', challenge: ch, ...lock }).result).toBe('locked_out')
    expect(OTP.decideVerify({ nowMs: now, email: 'a@b.co', code: '111111', challenge: { ...ch, consumedAtMs: now - 10 }, ...lock }).result).toBe('replay')
    expect(OTP.rateAddress('V.Ictim+promo@GoogleMail.com')).toBe('victim@gmail.com')
    expect(OTP.rateAddress('first.last+x@example.com')).toBe('first.last@example.com')
    expect(OTP.rateAddress('plain@example.com')).toBe('plain@example.com')
  })

  test('an email already on the caller\'s OWN Auth record (a partner CRM login) is never replaced — request', async () => {
    // A partner login: the address lives on Auth (password provider); the document copy is empty.
    authState.records.set(UID, { uid: UID, email: 'crm-login@example.com', emailVerified: false, providerData: [{ providerId: 'password' }] })
    const e = await refusal(request('personal@example.com'))
    expect(e.code).toBe('failed-precondition')
    expect(e.details.reason).toBe('contact_replacement_refused')
    expect(outbox.length).toBe(0)
  })

  test('…and at verify, if the Auth record gained a different address after the code was sent', async () => {
    await request('personal@example.com')
    const code = lastCode()
    authState.records.set(UID, { uid: UID, email: 'crm-login@example.com', emailVerified: true, providerData: [{ providerId: 'password' }] })
    const e = await refusal(verify('personal@example.com', code))
    expect(e.code).toBe('failed-precondition')
    expect(e.details.reason).toBe('contact_replacement_refused')
    expect(authState.updates.length).toBe(0)
    expect(db.read(`users/${UID}`).email).toBe(undefined)
  })

  test('the SAME address already on the Auth record (unproven) can be bound by code', async () => {
    authState.records.set(UID, { uid: UID, email: 'same@example.com', emailVerified: false, providerData: [{ providerId: 'password' }] })
    await request('same@example.com')
    const r = await verify('same@example.com', lastCode())
    expect(r.status).toBe('bound')
    expect(authState.records.get(UID).emailVerified).toBe(true)
  })

  test('ten wrong codes in a day lock the account out — a fresh code does not buy fresh guesses', async () => {
    await request('p@example.com')
    let right = lastCode()
    for (let i = 0; i < P.maxAttempts; i++) await refusal(verify('p@example.com', wrongOf(right)))
    advance(61_000)
    await request('p@example.com')
    right = lastCode()
    for (let i = 0; i < P.maxFailuresPerDay - P.maxAttempts; i++) await refusal(verify('p@example.com', wrongOf(right)))
    const locked = await refusal(verify('p@example.com', right))
    expect(locked.code).toBe('resource-exhausted')
    expect(locked.details.reason).toBe('locked_out')
    expect(db.read(`users/${UID}`).email).toBe(undefined)
    advance(61_000)
    const send = await refusal(request('p@example.com'))
    expect(send.details.reason).toBe('locked_out')
    advance(P.dayMs)
    expect((await request('p@example.com')).status).toBe('sent')
  })

  test('one account guessing at somebody else\'s address does not lock the OWNER out (review N1)', async () => {
    db.seed('users/ATTACKER', { name: 'x' })
    db.seed('users/OWNER', { name: 'o' })
    for (let round = 0; round < 2; round++) {
      await request('victim@example.com', ANON, 'ATTACKER')
      const c = lastCode()
      for (let i = 0; i < P.maxAttempts; i++) await refusal(verify('victim@example.com', wrongOf(c), ANON, 'ATTACKER'))
      advance(61_000)
    }
    // The attacker's own account is locked out for the day…
    expect((await refusal(request('victim@example.com', ANON, 'ATTACKER'))).details.reason).toBe('locked_out')
    // …but the owner can still ask for a code to their address and bind it.
    const r = await request('victim@example.com', ANON, 'OWNER')
    expect(r.status).toBe('sent')
    expect((await verify('victim@example.com', lastCode(), ANON, 'OWNER')).status).toBe('bound')
  })

  test('across MANY throwaway accounts the address itself locks at its own threshold', async () => {
    const perAccount = P.maxAttempts
    const needed = Math.ceil(P.maxFailuresPerAddressPerDay / perAccount)
    for (let i = 0; i <= needed; i++) db.seed(`users/T${i}`, { name: 'x' })
    for (let i = 0; i < needed; i++) {
      if (i > 0 && i % P.maxSendsPerAddressPerWindow === 0) advance(P.windowMs + 1)
      await request('target@example.com', ANON, `T${i}`)
      const c = lastCode()
      for (let k = 0; k < perAccount; k++) await refusal(verify('target@example.com', wrongOf(c), ANON, `T${i}`))
    }
    advance(P.windowMs + 1)
    const e = await refusal(request('target@example.com', ANON, `T${needed}`))
    expect(e.code).toBe('resource-exhausted')
    expect(e.details.reason).toBe('locked_out')
  })

  test('ten sends a day per account, even when each hour stays under five', async () => {
    for (let i = 0; i < P.maxSendsPerAccountPerDay; i++) {
      await request(`d${i}@example.com`)
      advance(i % P.maxSendsPerAccountPerWindow === P.maxSendsPerAccountPerWindow - 1 ? P.windowMs + 1 : 61_000)
    }
    const e = await refusal(request('d99@example.com'))
    expect(e.details.reason).toBe('rate_limited')
  })

  test('+tags and Gmail dots share ONE per-address budget', async () => {
    const variants = ['victim+1@gmail.com', 'v.ictim@gmail.com', 'victim+x@googlemail.com', 'vic.tim+2@gmail.com', 'victim@gmail.com']
    variants.forEach((v, i) => db.seed(`users/F${i}`, { name: 'x' }))
    for (let i = 0; i < variants.length; i++) await request(variants[i], ANON, `F${i}`)
    db.seed('users/F9', { name: 'x' })
    const e = await refusal(request('v.i.c.t.i.m+9@gmail.com', ANON, 'F9'))
    expect(e.details.reason).toBe('rate_limited')
    // what is mailed and bound is still the address exactly as typed
    expect(outbox[0].to).toBe('victim+1@gmail.com')
  })

  test('"already bound" hands an anonymous session its same-uid token (lost verify reply)', async () => {
    db.seed(`users/${UID}`, { name: 'g', email: 'me@example.com' })
    authState.records.set(UID, { uid: UID, email: 'me@example.com', emailVerified: true, providerData: [] })
    const anon = await request('me@example.com', ANON)
    expect(anon.status).toBe('already_bound')
    expect(anon.customToken).toBe(`custom-${UID}`)
    const phone = await request('me@example.com', PHONE)
    expect(phone.customToken).toBe(undefined)
  })

  test('a failed Auth write does NOT blank the document when the Auth side already holds the address', async () => {
    await request('p@example.com')
    const code = lastCode()
    // A concurrent retry finished first: the record already has the address.
    authState.records.set(UID, { uid: UID, email: 'p@example.com', emailVerified: true, providerData: [] })
    authState.updateError = new Error('timeout')
    const e = await refusal(verify('p@example.com', code))
    expect(e.code).toBe('unavailable')
    expect(db.read(`users/${UID}`).email).toBe('p@example.com')
  })

  test('the mail tells the person never to share the code; records carry expireAt for a TTL policy', async () => {
    await request('p@example.com')
    expect(outbox[0].text.includes('Do not share this code')).toBe(true)
    expect(db.read(`emailOtpChallenges/${UID}`).expireAt != null).toBe(true)
    const rates = db.all('emailOtpRate')
    expect(rates.length > 0).toBe(true)
    expect(rates.every((r) => r.expireAt != null)).toBe(true)
    // no rate record carries the address itself
    expect(JSON.stringify(rates).includes('p@example.com')).toBe(false)
  })

  test('bindVerifiedIdentity: a DISPLACED session still binds but gets no session token', async () => {
    db.seed(`users/${UID}`, { name: 'g', credentialsValidAfter: 3000 })
    const tok = { ...ANON, auth_time: 2000, phone_number: '+919800000003' }
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000003' }, ctx(tok))
    expect(r.bound).toBe(true)
    expect(r.customToken).toBe(undefined)
    expect(authState.minted.length).toBe(0)
  })

  test('bindVerifiedIdentity: a restricted account gets no session token', async () => {
    db.seed(`users/${UID}`, { name: 'g', isSuspended: true })
    const tok = { ...ANON, phone_number: '+919800000004' }
    // Whatever the bind itself answers for a suspended account, no token is minted.
    await refusal(ID.bindVerifiedIdentity.run({ phone: '+919800000004' }, ctx(tok)))
    expect(authState.minted.length).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('guest-ness after a code-bound email (isGuestAccount)', () => {
  test('a verified email on the Auth record plus the document → not a guest', async () => {
    authState.records.set(UID, { uid: UID, email: 'p@example.com', emailVerified: true, providerData: [] })
    db.seed(`users/${UID}`, { name: 'g', email: 'p@example.com' })
    expect(await ID.isGuestAccount(UID, ANON)).toBe(false)
  })
  test('an UNVERIFIED email on the record is still a guest', async () => {
    authState.records.set(UID, { uid: UID, email: 'p@example.com', emailVerified: false, providerData: [] })
    db.seed(`users/${UID}`, { name: 'g', email: 'p@example.com' })
    expect(await ID.isGuestAccount(UID, ANON)).toBe(true)
  })
  test('verified on Auth but never recorded on the document → still a guest', async () => {
    authState.records.set(UID, { uid: UID, email: 'p@example.com', emailVerified: true, providerData: [] })
    db.seed(`users/${UID}`, { name: 'g' })
    expect(await ID.isGuestAccount(UID, ANON)).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('bindVerifiedIdentity (phone) also refreshes an anonymous session', () => {
  test('anonymous session → customToken for the same uid', async () => {
    const tok = { ...ANON, phone_number: '+919800000002' }
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000002' }, ctx(tok))
    expect(r.bound).toBe(true)
    expect(r.customToken).toBe(`custom-${UID}`)
  })
  test('phone session → no token', async () => {
    db.seed('users/P2', { name: 'p' })
    const r = await ID.bindVerifiedIdentity.run({ phone: '+919800000001' }, ctx(PHONE, 'P2'))
    expect(r.bound).toBe(true)
    expect(r.customToken).toBe(undefined)
  })
})

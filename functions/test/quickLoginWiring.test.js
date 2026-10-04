/**
 * THE WIRING AROUND THE POLICY — WHERE TWO PLACES HAVE TO AGREE.
 *
 * `quickLoginPolicy.test.js` tests the decisions. `quickLoginSignature.test.js`
 * tests the cryptography. This file tests the joins: the places where a rule
 * lives in one file and is ENFORCED in another, and where the two drifting apart
 * would be silent.
 *
 * ── WHAT IS ACTUALLY BEING ASSERTED ──────────────────────────────────────────
 *
 * Two different kinds of check live here, and they are not worth the same:
 *
 *   BEHAVIOURAL — `destroysCredential`, `redemptionOutcome` and friends are
 *     imported and called. These are real tests of real code.
 *
 *   SOURCE ASSERTIONS — the rest read a source file and assert on its text.
 *     They are NOT equivalent to running the thing. A Firestore trigger needs an
 *     emulator, and Kotlin needs a Gradle build; neither exists in this
 *     environment. What a source assertion buys is narrow and worth stating: it
 *     catches the specific regression of somebody changing one side of an
 *     agreement and not the other. It cannot catch a mistake that is spelled
 *     correctly. Every one of them is labelled `[source]`.
 *
 * Run:  node --test test/quickLoginWiring.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const {
  destroysCredential,
  grantsSession,
  isReportableState,
  permitsAppeal,
  redemptionOutcome,
  statementProblem,
  CREDENTIAL_VERSION,
  MIN_STATEMENT_CHARS,
  MAX_STATEMENT_CHARS,
} = require('../lib/quickLoginPolicy')

const src = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8')
const app = (...p) =>
  readFileSync(
    join(__dirname, '..', '..', 'zipper-app', 'app', 'src', 'main', 'java', 'com', 'zipper', 'app', ...p),
    'utf8',
  )

/**
 * Text with comments removed, so a rule is never satisfied by prose about it.
 *
 * This matters more than it sounds. These files document what they USED to do —
 * "this used to pass setShouldBackupToCloud(true)" — and a source assertion that
 * reads comments would pass on the strength of the sentence describing the bug.
 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The same, named for the language, because Kotlin comments say the same things. */
const kotlin = code

/**
 * The position of a marker, which MUST be present.
 *
 * ── WHY THIS EXISTS, WHICH IS A CONFESSION ──────────────────────────────────
 *
 * Ordering tests were written as `expect(a.indexOf(x)).toBeLessThan(a.indexOf(y))`,
 * and `indexOf` returns -1 for something that is not there. So -1 < anything,
 * and every one of those tests PASSED when the first step was deleted outright.
 *
 * Mutation testing found it: removing the statement check entirely left the
 * "statement is validated before the challenge is consumed" test green. An
 * ordering assertion has to assert existence first, or it is an assertion about
 * nothing.
 */
function posOf(haystack, marker) {
  const i = haystack.indexOf(marker)
  if (i < 0) throw new Error(`marker not found, so there is no order to check: ${marker}`)
  return i
}

/*
 * Named `posOf` and not `at`, because `at` is shadowed by a local in three of
 * the blocks below and the shadowed call failed with "at is not a function" —
 * which the suite caught, but only because the mutation run made it run.
 */

const IDENTITY = src('src', 'identity.ts')
const QUICK_LOGIN = src('src', 'quickLogin.ts')
const STORE = app('util', 'QuickLoginStore.kt')
const DEVICE_KEY = app('util', 'DeviceKey.kt')
const REPO = app('data', 'repository', 'AuthRepository.kt')
const MONEY = app('data', 'repository', 'MoneyFunctions.kt')

// ══════════════════════════════════════════════════════════════════════════════
//  1. Suspension keeps the credential — in BOTH places that decide
// ══════════════════════════════════════════════════════════════════════════════

describe('a restricted account keeps the credential, and nothing contradicts it', () => {
  // ── THE RULE ───────────────────────────────────────────────────────────────
  //
  // Ban and suspension KEEP the credential. Only deletion destroys it.
  //
  // This is the A5 fix and it is worth stating why, because it reads backwards
  // at first glance. `set_user_disabled(uid, True)` revokes the Firebase session
  // the moment the CRM bans somebody, and the appeal form on the ban screen is
  // an authenticated Firestore write. Destroying the quick-login credential as
  // well left a banned person with no identifier of any kind — so the one thing
  // a wrongly banned person needs to do became the one thing they could not do.
  //
  // Nothing is admitted by keeping it: `grantsSession` is false for both states,
  // no custom token is minted, and the Firebase login stays disabled. The
  // credential buys exactly one thing, and `permitsAppeal` names it.

  test('suspension keeps it', () => {
    expect(destroysCredential('suspended')).toBe(false)
  })

  test('a BAN keeps it too — this is the A5 fix', () => {
    expect(destroysCredential('banned')).toBe(false)
  })

  test('only deletion destroys it', () => {
    // Recovery is its own flow with its own proof, and there is no appeal
    // against a deletion the person asked for.
    expect(destroysCredential('deleted')).toBe(true)
    for (const o of ['allow', 'banned', 'suspended', 'device_banned', 'refused', 'legacy', 'rate_limited']) {
      expect(destroysCredential(o)).toBe(false)
    }
  })

  test('…and neither restricted state grants a session', () => {
    // The other half of the rule. Keeping the credential would be a hole if it
    // also admitted anyone.
    expect(grantsSession('banned')).toBe(false)
    expect(grantsSession('suspended')).toBe(false)
    expect(grantsSession('allow')).toBe(true)
  })

  test('exactly ban and suspension permit an appeal', () => {
    expect(permitsAppeal('banned')).toBe(true)
    expect(permitsAppeal('suspended')).toBe(true)
    // `allow` is refused too: an unrestricted account has nothing to appeal, and
    // accepting it would put noise in the queue ahead of real appeals.
    for (const o of ['allow', 'device_banned', 'deleted', 'refused', 'legacy', 'rate_limited']) {
      expect(permitsAppeal(o)).toBe(false)
    }
  })

  test('[source] revokeQuickLoginOnRestriction fires on DELETION ONLY', () => {
    // The drift this file exists for, and it has now caught the same class of
    // bug twice. The trigger deleting credentials on ban or suspension would
    // destroy the appeal proof that `destroysCredential` says to keep.
    const trigger = code(IDENTITY).split('revokeQuickLoginOnRestriction')[1] ?? ''
    const body = trigger.slice(0, trigger.indexOf('claimGuestIdentity'))
    expect(body.includes('isDeleted')).toBe(true)
    expect(body.includes('isBanned')).toBe(false)
    expect(body.includes('isSuspended')).toBe(false)
  })

  test('[source] and the trigger agrees with destroysCredential, outcome by outcome', () => {
    // Pinned as a correspondence rather than as two lists that happen to match
    // today. `destroysCredential` is the policy; the trigger is an eager
    // application of it; a future outcome added to one must be added to both.
    const trigger = code(IDENTITY).split('revokeQuickLoginOnRestriction')[1] ?? ''
    const body = trigger.slice(0, trigger.indexOf('claimGuestIdentity'))
    const fieldFor = { banned: 'isBanned', suspended: 'isSuspended', deleted: 'isDeleted' }
    for (const [outcome, field] of Object.entries(fieldFor)) {
      expect(body.includes(field)).toBe(destroysCredential(outcome))
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  2. Order of checks: the signature before the account
// ══════════════════════════════════════════════════════════════════════════════

describe('a caller who cannot prove the device learns nothing', () => {
  test('a bad signature over a BANNED account reports only `refused`', () => {
    // Not `banned`. Otherwise an unauthenticated caller holding a stolen secret
    // could discover the moderation status of the account behind it.
    const outcome = redemptionOutcome({
      rate: null,
      credential: {
        uid: 'u1',
        version: CREDENTIAL_VERSION,
        publicKey: 'pem',
        expiresAt: { toMillis: () => 2_000_000_000_000 },
      },
      account: { isBanned: true },
      deviceBanned: false,
      signatureValid: false,
      nowMs: 1_000_000_000_000,
    })
    expect(outcome).toBe('refused')
  })

  test('…and the same attempt WITH a valid signature reports the ban', () => {
    const outcome = redemptionOutcome({
      rate: null,
      credential: {
        uid: 'u1',
        version: CREDENTIAL_VERSION,
        publicKey: 'pem',
        expiresAt: { toMillis: () => 2_000_000_000_000 },
      },
      account: { isBanned: true },
      deviceBanned: false,
      signatureValid: true,
      nowMs: 1_000_000_000_000,
    })
    expect(outcome).toBe('banned')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  3. The three collections are all swept
// ══════════════════════════════════════════════════════════════════════════════

describe('[source] housekeeping covers everything quick login writes', () => {
  const sweep = code(IDENTITY)

  test('credentials expire out', () => {
    expect(sweep.includes("sweepExpired('quickLoginTokens'")).toBe(true)
  })

  test('challenges too — the collection that grows per tap', () => {
    // One document per attempt, two-minute life, never read again once spent.
    // Left unswept this is the fastest-growing collection in the system.
    expect(sweep.includes("sweepExpired('quickLoginChallenges'")).toBe(true)
  })

  test('and rate records, so last month\'s failures do not count', () => {
    expect(sweep.includes("sweepExpired('quickLoginRate'")).toBe(true)
  })

  test('rate records are given a grace period, not swept at `now`', () => {
    // Sweeping a counter at `now` could clear a cool-off between two attempts,
    // which would make the ceiling unreachable.
    //
    // Asserted on the CALL and not merely on the identifier existing somewhere
    // in the file. A mutation that changed the argument to `now` while leaving
    // the `rateCutoff` declaration in place passed the weaker version of this
    // test, which is how it got written this way.
    expect(sweep.includes("sweepExpired('quickLoginRate', 'updatedAt', rateCutoff)")).toBe(true)
    expect(sweep.includes("sweepExpired('quickLoginRate', 'updatedAt', now)")).toBe(false)
  })

  test('…and credentials and challenges are swept at `now`, not a grace period', () => {
    // The opposite direction. A credential or challenge given a day of grace is
    // a credential or challenge that outlives its own expiry by a day.
    expect(sweep.includes("sweepExpired('quickLoginTokens', 'expiresAt', now)")).toBe(true)
    expect(sweep.includes("sweepExpired('quickLoginChallenges', 'expiresAt', now)")).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  4. Nothing logs a secret
// ══════════════════════════════════════════════════════════════════════════════

describe('[source] no credential, signature or challenge is ever recorded', () => {
  const body = code(QUICK_LOGIN)

  /** Every `await recordEvent(...)` call, bounded by balanced parentheses. */
  function eventCalls(text) {
    const calls = []
    const marker = 'await recordEvent('
    let at = text.indexOf(marker)
    while (at >= 0) {
      let depth = 0
      let i = at + marker.length - 1
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++
        else if (text[i] === ')' && --depth === 0) break
      }
      calls.push(text.slice(at, i + 1))
      at = text.indexOf(marker, i)
    }
    return calls
  }

  const calls = eventCalls(body)

  test('there are events to check', () => {
    // Guards the extractor itself. A regression that renamed the call would
    // otherwise make every assertion below pass over an empty list.
    expect(calls.length).toBeGreaterThan(5)
  })

  test('no event carries a raw secret, signature or challenge', () => {
    // Credentials in an audit trail are credentials in one more place. Each one
    // goes through `fingerprint()`, which is a truncated SHA-256 and not
    // reversible.
    for (const call of calls) {
      const stripped = call.replace(/fingerprint\([^)]*\)/g, 'FP')
      expect(/\b(secret|replacement|signature|challenge)\b/.test(stripped)).toBe(false)
    }
  })

  test('at least one event does fingerprint a credential', () => {
    // Otherwise the assertion above is satisfied by an audit trail that records
    // nothing identifying at all, which would make it untraceable instead.
    expect(calls.some((c) => c.includes('fingerprint('))).toBe(true)
  })

  test('the signature is never written to Firestore', () => {
    expect(/\.set\([^)]*\bsignature\b/.test(body)).toBe(false)
    expect(/\.add\([^)]*\bsignature\b/.test(body)).toBe(false)
  })

  test('the credential document id is a hash, not the secret', () => {
    expect(body.includes('doc(hash(secret))')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  5. The Android side — source assertions, and they are only that
// ══════════════════════════════════════════════════════════════════════════════

describe('[source] the Android credential cannot travel', () => {
  test('Block Store cloud backup is OFF for the quick-login blob', () => {
    // The transfer channel. With it on, the bytes arrive on the next handset —
    // which is exactly what the Keystore binding exists to make useless, and
    // there is no reason to ship both halves of the old hole.
    //
    // Checked against comment-stripped source. The class note explains what the
    // call USED to be, and a test satisfied by prose about a rule is not a test
    // of the rule.
    const body = kotlin(STORE)
    expect(body.includes('setShouldBackupToCloud(false)')).toBe(true)
    expect(body.includes('setShouldBackupToCloud(true)')).toBe(false)
  })

  test('the device key is generated inside the Android Keystore', () => {
    const body = kotlin(DEVICE_KEY)
    expect(body.includes('"AndroidKeyStore"')).toBe(true)
    expect(body.includes('KeyProperties.KEY_ALGORITHM_EC')).toBe(true)
    expect(body.includes('SHA256withECDSA')).toBe(true)
  })

  test('…and the private half is never exported', () => {
    // No getEncoded() on a private key, no PEM of one, no way out.
    expect(/privateKey[\s\S]{0,40}encoded/.test(kotlin(DEVICE_KEY))).toBe(false)
  })
})

describe('[source] the Android flow is challenge, sign, redeem', () => {
  const body = kotlin(REPO)
  const flow = body.slice(body.indexOf('suspend fun signInWithQuickLogin'))
  const fn = flow.slice(0, flow.indexOf('private suspend fun refuseQuickLogin'))

  test('all three steps are present', () => {
    expect(fn.includes('money.quickLoginChallenge()')).toBe(true)
    expect(fn.includes('deviceKey.sign(')).toBe(true)
    expect(fn.includes('money.redeemQuickLogin(')).toBe(true)
  })

  test('and in that order', () => {
    expect(posOf(fn, 'money.quickLoginChallenge()')).toBeLessThan(posOf(fn, 'deviceKey.sign('))
    expect(posOf(fn, 'deviceKey.sign(')).toBeLessThan(posOf(fn, 'money.redeemQuickLogin('))
  })

  test('and what is signed is the SERVER\'S challenge, with its own id', () => {
    // Order is not enough: signing a constant, or sending a challenge id the
    // signature is not over, keeps every ordering assertion green and makes
    // every redemption fail. See the same pair in the appeal block.
    expect(fn.includes('deviceKey.sign(challenge.challenge)')).toBe(true)
    expect(fn.includes('challengeId = challenge.challengeId')).toBe(true)
  })

  test('the rotated credential is saved BEFORE the session is opened', () => {
    // The old secret is dead the moment it is spent. Saving the replacement
    // after `signInWithCustomToken` could fail would leave the device holding a
    // credential that will never work again.
    expect(posOf(fn, 'quickLogin.save(')).toBeLessThan(
      posOf(fn, 'auth.signInWithCustomToken('),
    )
  })

  test('…and the save is guarded on the token, not on something that can never fire', () => {
    // Text order alone is not enough. A guard mutated to `if (false)` leaves the
    // call in place, in the right order, and never saves anything — which the
    // ordering assertion above cannot see. So the CONDITION is pinned too.
    expect(/if \(value\.token\.isNotBlank\(\)\)\s*\{\s*quickLogin\.save\(/.test(fn)).toBe(true)
  })

  test('a suspended account is routed as a suspension, not an error', () => {
    expect(fn.includes('RestrictionKind.Suspension')).toBe(true)
  })

  test('no key means no attempt', () => {
    expect(fn.includes('deviceKey.hasKey()')).toBe(true)
  })
})

describe('[source] minting refuses to produce an unbound credential', () => {
  const body = kotlin(REPO)
  const mint = body.slice(body.indexOf('private suspend fun mintQuickLoginCredential'))
  const fn = mint.slice(0, mint.indexOf('suspend fun savedQuickLogin'))

  test('it asks for a public key first', () => {
    expect(fn.includes('deviceKey.publicKeyPem()')).toBe(true)
  })

  test('and returns without minting when there is none', () => {
    expect(/publicKey\.isNullOrBlank\(\)[\s\S]{0,120}return/.test(fn)).toBe(true)
  })

  test('the callable will not accept a mint without one either', () => {
    expect(kotlin(MONEY).includes('fun mintQuickLoginToken(deviceId: String, publicKey: String)')).toBe(true)
    expect(code(QUICK_LOGIN).includes("publicKey.includes('BEGIN PUBLIC KEY')")).toBe(true)
  })
})

describe('[source] a refusal destroys the credential only when it should', () => {
  const body = kotlin(REPO)
  const start = body.indexOf('private suspend fun refuseQuickLogin')
  const fn = body.slice(start, body.indexOf('suspend fun findExistingAccount', start))

  /** The branch body for one detail code, up to the next `"` -> arm. */
  function arm(detail) {
    const at = fn.indexOf(`"${detail}"`)
    if (at < 0) return ''
    const rest = fn.slice(at)
    const next = rest.slice(1).search(/\n {16}"|\n {16}else/)
    return next < 0 ? rest : rest.slice(0, next + 1)
  }

  test('rate_limited keeps it', () => {
    // Five wrong attempts must not cost the real holder their credential.
    expect(arm('rate_limited').includes('quickLogin.clear()')).toBe(false)
  })

  test('device_banned keeps it', () => {
    // The handset is barred, not the credential. A lifted ban should find it.
    expect(arm('device_banned').includes('quickLogin.clear()')).toBe(false)
  })

  test('legacy clears it — that is the migration', () => {
    expect(arm('legacy').includes('quickLogin.clear()')).toBe(true)
  })

  test('banned does NOT clear it — the credential is the appeal proof', () => {
    // This arm is only reached against an older server; a current one returns
    // `banned` as a payload. Either way it must not destroy the credential:
    // banning revokes the session, so the credential is the only identifier
    // left, and `AppealRepository.appealWithoutSession` needs it.
    expect(arm('banned').includes('quickLogin.clear()')).toBe(false)
  })

  test('an unknown detail keeps it', () => {
    // A client that deletes on anything it does not recognise deletes on every
    // future addition to the server's vocabulary.
    expect(fn.includes('else -> AuthResult.Error(res.userMessage)')).toBe(true)
  })

  test('and the detail code is read from the server, not guessed from the message', () => {
    expect(kotlin(MONEY).includes('private fun detailCode(')).toBe(true)
    expect(code(QUICK_LOGIN).includes('{ code: outcome }')).toBe(true)
  })
})

describe('[source] forgetting this device destroys the binding too', () => {
  const body = kotlin(REPO)

  /** One function body, from its signature to the next top-level `suspend fun`. */
  function bodyOf(signature) {
    const at = body.indexOf(signature)
    if (at < 0) return ''
    const rest = body.slice(at + signature.length)
    const next = rest.search(/\n {4}(suspend )?fun /)
    return next < 0 ? rest : rest.slice(0, next)
  }

  test('"sign out and forget" deletes the key, not just the secret', () => {
    // Clearing the secret alone leaves the binding alive. Deleting the Keystore
    // entry is what makes "forget this device" true: no credential minted here
    // can be signed for again, whatever became of its bytes.
    const fn = bodyOf('suspend fun signOutAndForget()')
    expect(fn.includes('quickLogin.clear()')).toBe(true)
    expect(fn.includes('deviceKey.clear()')).toBe(true)
  })

  test('…and an ORDINARY sign-out deletes neither', () => {
    // Remembering across an ordinary sign-out is the entire feature. This is the
    // one assertion that would catch somebody "fixing" quick login by clearing
    // it on every sign-out.
    const fn = bodyOf('suspend fun signOut(deviceId: String = "", mintQuickLogin: Boolean = true)')
    expect(fn.length).toBeGreaterThan(0)
    expect(fn.includes('quickLogin.clear()')).toBe(false)
    expect(fn.includes('deviceKey.clear()')).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  6. A5 — the appeal that needs no session
// ══════════════════════════════════════════════════════════════════════════════

describe('the appeal statement, server-side', () => {
  // Checked on the server as well as on the device, because the callable is
  // unauthenticated and the client's own check is a courtesy to the typist.
  test('too short is refused, with a sentence that says what to do', () => {
    const problem = statementProblem('too short')
    expect(problem.length).toBeGreaterThan(0)
    expect(problem.includes(String(MIN_STATEMENT_CHARS))).toBe(true)
  })

  test('empty and whitespace-only are refused', () => {
    expect(statementProblem('').length).toBeGreaterThan(0)
    expect(statementProblem('   \n\t  ').length).toBeGreaterThan(0)
    expect(statementProblem(null).length).toBeGreaterThan(0)
    expect(statementProblem(undefined).length).toBeGreaterThan(0)
  })

  test('exactly the minimum is accepted', () => {
    expect(statementProblem('x'.repeat(MIN_STATEMENT_CHARS))).toBe('')
  })

  test('one under the minimum is not', () => {
    expect(statementProblem('x'.repeat(MIN_STATEMENT_CHARS - 1))).not.toBe('')
  })

  test('the maximum is honoured, and one over is refused', () => {
    expect(statementProblem('x'.repeat(MAX_STATEMENT_CHARS))).toBe('')
    expect(statementProblem('x'.repeat(MAX_STATEMENT_CHARS + 1))).not.toBe('')
  })

  test('the limits match firestore.rules, which polices the other route', () => {
    // Two writers, one collection. A statement the callable accepts but the
    // rules reject — or the reverse — would mean an appeal that can be filed one
    // way and not the other, for no reason a person could understand.
    const rules = code(readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8'))
    expect(rules.includes(`statement.size() >= ${MIN_STATEMENT_CHARS}`)).toBe(true)
    expect(rules.includes(`statement.size() <= ${MAX_STATEMENT_CHARS}`)).toBe(true)
  })
})

describe('[source] submitAccountAppeal', () => {
  const body = code(QUICK_LOGIN)
  const at = body.indexOf('export const submitAccountAppeal')
  const fn = at < 0 ? '' : body.slice(at, body.indexOf('async function appealStateFor'))

  test('it exists and is exported', () => {
    expect(fn.length).toBeGreaterThan(0)
    expect(code(readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8'))
      .includes('submitAccountAppeal')).toBe(true)
  })

  test('it verifies a device signature', () => {
    // The whole basis of the endpoint. Without this it is an open intake with a
    // uid attached to whatever somebody sent.
    expect(fn.includes('verifySignature(')).toBe(true)
    expect(fn.includes('consumeChallenge(')).toBe(true)
  })

  test('…and gates on permitsAppeal, not on its own copy of the rule', () => {
    expect(fn.includes('permitsAppeal(outcome)')).toBe(true)
  })

  test('it never mints a session', () => {
    // The one thing that would turn an appeal endpoint into a way back in.
    expect(fn.includes('createCustomToken')).toBe(false)
  })

  test('the statement is validated before the challenge is consumed', () => {
    // A statement that is too short is the one error a person can fix by
    // retyping. Burning their single-use challenge on it would make them ask for
    // another one they cannot see.
    expect(posOf(fn, 'statementProblem(')).toBeLessThan(posOf(fn, 'consumeChallenge('))
  })

  test('the appeal is written with status pending and nothing else decides', () => {
    expect(fn.includes("status: 'pending'")).toBe(true)
    expect(/status:\s*['"](approved|rejected|upheld)/.test(fn)).toBe(false)
  })

  test('the field set matches appealFields() in firestore.rules exactly', () => {
    // The rules use `hasOnly`, and the CRM reads one shape whichever route an
    // appeal arrived by. A field in one and not the other is a divergence that
    // shows up as a missing column in somebody's review queue.
    const rules = readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    const declared = (rules.split('function appealFields()')[1] ?? '')
      .split('}')[0]
      .match(/'([a-zA-Z]+)'/g)
      ?.map((s) => s.replace(/'/g, '')) ?? []
    expect(declared.length).toBeGreaterThan(10)
    for (const field of declared) {
      // `field:` or the ES6 shorthand `field,` — both write the key. Checking
      // only for the colon form failed on `statement,` and said the field was
      // missing when it was there, which is a worse failure than none.
      const written = new RegExp(`\\b${field}\\s*[:,]`).test(fn)
      expect(written).toBe(true)
    }
  })

  test('the statement text is not copied into the audit event', () => {
    // Somebody's account of what happened to them belongs in the appeal
    // document, where a reviewer reads it — not in a second place with different
    // retention. Only its LENGTH is recorded.
    const event = fn.slice(fn.indexOf("recordEvent('ACCOUNT_APPEAL_SUBMITTED'"))
    const call = event.slice(0, event.indexOf('})'))
    expect(call.includes('statementChars')).toBe(true)
    // `statement.length` is a measurement, not the text. What must not appear is
    // the value itself — as a shorthand key, or as the value of any key.
    const withoutMeasurements = call.replace(/statementChars:\s*statement\.length/g, '')
    expect(/\bstatement\s*,/.test(withoutMeasurements)).toBe(false)
    expect(/:\s*statement\b(?!\.)/.test(withoutMeasurements)).toBe(false)
  })

  test('a duplicate is reported, not filed', () => {
    expect(fn.includes("status: 'already_pending'")).toBe(true)
  })

  test('a refused appeal counts against the rate limit', () => {
    // Otherwise the appeal endpoint is a way around the cool-off that protects
    // redemption, since both are unauthenticated and keyed on the same hash.
    expect(fn.includes('nextFailureState(')).toBe(true)
  })

  test('the device ban is deliberately not consulted', () => {
    // A barred handset and a banned account are two different facts. Refusing to
    // hear about the second because of the first would mean the people under the
    // most moderation are the ones who cannot appeal any of it.
    expect(fn.includes('deviceBanned: false')).toBe(true)
    expect(fn.includes('isDeviceBanned(')).toBe(false)
  })
})

describe('[source] the Android session-less appeal', () => {
  const APPEAL = kotlin(app('data', 'repository', 'AppealRepository.kt'))

  test('no session falls through to the device-signature route', () => {
    expect(APPEAL.includes('?: return appealWithoutSession(text)')).toBe(true)
  })

  test('…and the length check happens BEFORE the session check', () => {
    // Otherwise a signed-out person with a two-word statement is told to sign in
    // rather than told to write more, which is the wrong instruction.
    //
    // Scoped to the FUNCTION BODY. The first version compared against the whole
    // file, where the first `MIN_STATEMENT` is the companion-object declaration
    // near the top — so it was comparing a constant's declaration with a use
    // hundreds of lines away, and a mutation that moved the session check
    // earlier did not register.
    const start = posOf(APPEAL, 'suspend fun appealMyBan(')
    const fn = APPEAL.slice(start, posOf(APPEAL, 'private suspend fun appealWithoutSession'))
    expect(posOf(fn, 'MIN_STATEMENT')).toBeLessThan(posOf(fn, 'auth.currentUser'))
  })

  test('the route is challenge, sign, submit', () => {
    const at = APPEAL.indexOf('private suspend fun appealWithoutSession')
    const fn = APPEAL.slice(at, APPEAL.indexOf('suspend fun myAppeals'))
    expect(posOf(fn, 'money.quickLoginChallenge()')).toBeLessThan(posOf(fn, 'deviceKey.sign('))
    expect(posOf(fn, 'deviceKey.sign(')).toBeLessThan(posOf(fn, 'money.submitAccountAppeal('))
  })

  test('…and what is signed is the SERVER\'S challenge', () => {
    // The ordering assertions above do not care what goes into `sign()`. A
    // mutation that signed a constant kept the order intact and broke every
    // appeal — the signature would verify against nothing, and the person would
    // be told the device could not prove itself. Found by mutation testing; this
    // is the assertion that was missing.
    const at = APPEAL.indexOf('private suspend fun appealWithoutSession')
    const fn = APPEAL.slice(at, APPEAL.indexOf('suspend fun myAppeals'))
    expect(fn.includes('deviceKey.sign(challenge.challenge)')).toBe(true)
  })

  test('and the challenge ID sent is the one that was issued', () => {
    // Signing the right bytes against the wrong id is the same failure wearing
    // a different hat: the server consumes a challenge the signature is not over.
    const at = APPEAL.indexOf('private suspend fun appealWithoutSession')
    const fn = APPEAL.slice(at, APPEAL.indexOf('suspend fun myAppeals'))
    expect(fn.includes('challengeId = challenge.challengeId')).toBe(true)
  })

  test('it refuses honestly when the device cannot prove anything', () => {
    // A reinstall mints a new Keystore key, so an old credential cannot be
    // signed for. There is nothing the app can do about that, and saying so
    // beats a failure that sounds retryable.
    const at = APPEAL.indexOf('private suspend fun appealWithoutSession')
    const fn = APPEAL.slice(at, APPEAL.indexOf('suspend fun myAppeals'))
    expect(fn.includes('deviceKey.hasKey()')).toBe(true)
    expect(fn.includes('contact support')).toBe(true)
  })

  test('already_pending is not reported as a failure', () => {
    expect(APPEAL.includes('Result.AlreadyPending')).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
//  7. Displacement still mints nothing
// ══════════════════════════════════════════════════════════════════════════════

describe('[source] §7 — displacement is not a restoration path', () => {
  test('a forced teardown passes mintQuickLogin = false', () => {
    const vm = kotlin(app('ui', 'screens', 'auth', 'SessionViewModel.kt'))
    expect(vm.includes('mintQuickLogin = false')).toBe(true)
  })

  test('and startMobileSession revokes the displaced device\'s credentials', () => {
    const body = code(IDENTITY)
    const fn = body.slice(body.indexOf('startMobileSession'))
    expect(fn.includes('quickLoginTokens')).toBe(true)
  })
})

/**
 * ONE DEVICE, ONE GUEST ACCOUNT.
 *
 * Every test here is a situation a real handset gets into, and the two ways to
 * fail them are not symmetric:
 *
 *   * Handing out a session that is not this install's  → account takeover.
 *   * Creating one account too many                     → the original bug.
 *     A guest's diamonds, level and history stranded on a uid nothing can reach,
 *     a fresh empty account in front of the person, and nothing anywhere saying
 *     why. Not lost — worse than lost, because it looks like a working app.
 *
 * The second one is the reason the invariant is server-side at all. The client
 * used to answer "has this device been a guest before?" from local storage, and
 * local storage answers NO whenever it cannot be read — after a reinstall, or
 * when Play Services does not respond. So the fallback for *not knowing* was to
 * create a second account.
 *
 * Run:  node --test test/guestBinding.test.js
 */

const { test, describe } = require('node:test')
const { expect } = require('./expect')

const { decideGuestClaim, bindingPayload, BINDING_GRACE_MS } = require('../lib/guestBinding')

/** A settled binding, old enough that the grace window has passed. */
const OLD = BINDING_GRACE_MS + 1

/**
 * The ordinary healthy case, overridden per test.
 *
 * Spelled out as a base rather than eight positional arguments so that each
 * test below reads as the one fact it is about.
 */
const ask = (over = {}) => decideGuestClaim({
  deviceBanned: false,
  boundUid: '',
  secretMatches: false,
  boundUserExists: false,
  boundIsUpgraded: false,
  bindingAgeMs: null,
  wantedUid: '',
  // A client that has just created an anonymous account holds nothing, which is
  // the common case for a caller arriving with a uid.
  wantedUserExists: false,
  wantedIsUpgraded: false,
  callerIsBoundUid: false,
  ...over,
})

/** A device whose guest account is alive and whose secret is correct. */
const healthy = (over = {}) => ask({
  boundUid: 'UID_A',
  secretMatches: true,
  boundUserExists: true,
  bindingAgeMs: OLD,
  ...over,
})

// ── CASE A: this device already has a guest ──────────────────────────────────

describe('a device that already has a guest account', () => {
  test('gets that account back, and is never offered a new one', () => {
    const d = healthy()
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('touch')
  })

  test('gets it back even while presenting a brand-new uid', () => {
    /*
     * THE TEST THAT MATTERS MOST.
     *
     * This is a client that created an anonymous account before asking — the old
     * behaviour, and what a stale build in the wild still does. The server does
     * not bind UID_B, does not overwrite UID_A, and does not end up with two
     * guests on one handset. The caller's uid is a request, not an instruction.
     */
    const d = healthy({ wantedUid: 'UID_B' })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('touch')
  })
})

// ── CASE B: no guest yet ─────────────────────────────────────────────────────

describe('a device that has never had a guest', () => {
  test('is told so, and nothing is created by the asking', () => {
    const d = ask()
    expect(d.status).toBe('no_guest')
    expect(d.write).toBe('none')
    expect(d.uid).toBe('')
  })

  test('binds the uid it then creates', () => {
    const d = ask({ wantedUid: 'UID_NEW' })
    expect(d.status).toBe('bound')
    expect(d.uid).toBe('UID_NEW')
    expect(d.write).toBe('bind')
    // Nothing was displaced, so there is nothing to record.
    expect(d.replacedReason).toBe('')
  })
})

// ── CASE C: the quick-login secret is gone but the binding is not ────────────

describe('a reinstall with no quick-login secret left', () => {
  test('still recovers the account, because the binding is what decides', () => {
    /*
     * The case the old code got wrong. No live session and no quick-login secret
     * used to mean `signInAnonymously()` — a second account. The binding does not
     * care that quick login is missing: the device secret proved ownership.
     */
    const d = healthy()
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })
})

// ── CASE D: the device secret is gone ────────────────────────────────────────

describe('an install that cannot prove it owns the bound account', () => {
  test('is refused, and is NOT given a replacement account', () => {
    /*
     * The honest dead end, and it is on purpose. A second empty guest account
     * here would look like success and would strand the first one for ever;
     * being told plainly leaves Google and phone sign-in working, and leaves the
     * balance where it is.
     */
    const d = healthy({ secretMatches: false })
    expect(d.status).toBe('unrecoverable')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('none')
  })

  test('cannot bind its way past the refusal by sending a uid', () => {
    const d = healthy({ secretMatches: false, wantedUid: 'UID_C' })
    expect(d.status).toBe('unrecoverable')
    expect(d.write).toBe('none')
    // UID_C is never bound, and UID_A is never overwritten.
    expect(d.uid).toBe('UID_A')
  })

  test('keeps the account if it is still signed in as it, and re-keys', () => {
    /*
     * The repair. A verified ID token for the bound uid is stronger proof than
     * the secret it has lost, so the handset keeps its account and gets a
     * working secret again rather than a permanent refusal.
     */
    const d = healthy({ secretMatches: false, callerIsBoundUid: true })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('rekey')
  })

  test('a session for a DIFFERENT account buys nothing', () => {
    // `callerIsBoundUid` is computed from the bound uid, never from a uid the
    // caller supplies, so this is the only thing it can mean.
    const d = healthy({ secretMatches: false, callerIsBoundUid: false, wantedUid: 'UID_A' })
    expect(d.status).toBe('unrecoverable')
    expect(d.write).toBe('none')
  })

  test('re-keying never moves the binding to another uid', () => {
    const d = healthy({ secretMatches: false, callerIsBoundUid: true, wantedUid: 'UID_C' })
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('rekey')
  })
})

// ── CASE E: two launches racing on one device ────────────────────────────────

describe('two processes on one handset starting at once', () => {
  test('the loser is handed the winner\'s account, not a second one', () => {
    /*
     * Both read `no_guest`, both created an anonymous account, and one bound
     * first. The transaction is what makes the second one arrive here reading a
     * live binding; this asserts what it is then told.
     */
    const d = healthy({ wantedUid: 'UID_LOSER' })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('touch')
  })

  test('a binding written seconds ago is in flight, not dead', () => {
    /*
     * The profile document is written just after the binding, so for a moment a
     * live binding legitimately points at a uid with no document. Reading that as
     * "purged" would discard the account the other process just made — the race
     * producing exactly the duplicate it was meant to prevent.
     */
    const d = healthy({ boundUserExists: false, bindingAgeMs: 5_000 })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })
})

// ── CASE F: the bound account is gone ────────────────────────────────────────

describe('a binding whose account no longer exists', () => {
  test('is replaceable, so deleting a guest does not bar the handset for ever', () => {
    const d = healthy({ boundUserExists: false, wantedUid: 'UID_FRESH' })
    expect(d.status).toBe('bound')
    expect(d.uid).toBe('UID_FRESH')
    expect(d.write).toBe('bind')
    expect(d.replacedReason).toBe('account_purged')
  })

  test('reports no_guest first, so nothing is created before the server agrees', () => {
    const d = healthy({ boundUserExists: false })
    expect(d.status).toBe('no_guest')
    expect(d.write).toBe('none')
  })

  test('a deletion still inside its window is NOT purged', () => {
    /*
     * A soft-deleted account keeps its document, so it reads as live here and the
     * device is handed back to it — which is the only way the person reaches the
     * "restore your account?" screen that `resolveIdentity` owns. Reading it as
     * purged instead would quietly give them a new empty guest account during the
     * very window the deletion is meant to be reversible in.
     */
    const d = healthy({ boundUserExists: true })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })

  test('a purged account does not need the secret to be replaced', () => {
    // There is no account left to protect, and demanding proof of a dead pointer
    // would make account deletion a permanent ban from guest mode.
    const d = healthy({ boundUserExists: false, secretMatches: false, wantedUid: 'UID_FRESH' })
    expect(d.status).toBe('bound')
    expect(d.uid).toBe('UID_FRESH')
  })
})

// ── CASE E: the device binding and the caller disagree ───────────────────────

describe('a live session for one account on a device bound to another', () => {
  test('fails closed when both accounts hold data', () => {
    /*
     * Neither side is assumed correct. Picking the binding abandons whatever is
     * in the caller's account; picking the caller hands the device to an account
     * that did not earn it; creating a third is the duplicate bug with extra
     * steps. So: refuse, and leave something for a human to look at.
     */
    const d = healthy({ wantedUid: 'UID_B', wantedUserExists: true })
    expect(d.status).toBe('conflict')
    expect(d.write).toBe('none')
    expect(d.uid).toBe('UID_A')
  })

  test('does not fail closed on an empty account, which is only a lost race', () => {
    const d = healthy({ wantedUid: 'UID_B', wantedUserExists: false })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })

  test('a conflict is never resolved by writing anything', () => {
    for (const secretMatches of [true, false]) {
      for (const callerIsBoundUid of [true, false]) {
        const d = healthy({
          wantedUid: 'UID_B', wantedUserExists: true, secretMatches, callerIsBoundUid,
        })
        expect(d.write).toBe('none')
        expect(d.uid).not.toBe('UID_B')
      }
    }
  })
})

// ── The saved sign-in that is not a guest at all ─────────────────────────────

describe('a caller offering an account that is not a guest', () => {
  test('is never written into the guest slot', () => {
    /*
     * THE BUG THIS WAS FOUND BY. Quick login is tried first in the guest flow for
     * speed, and it restores whatever account was last signed in on the handset —
     * which for most people is their email or Google account. Tapping "Continue
     * as guest" opened that account and offered its uid for binding.
     *
     * Two things broke at once: the person asked for a guest and got their real
     * account, and the device's guest slot was about to be filled by an account
     * that is not a guest — which bars that handset from ever having one.
     */
    const d = ask({ wantedUid: 'UID_EMAIL', wantedIsUpgraded: true })
    expect(d.status).toBe('not_a_guest')
    expect(d.write).toBe('none')
  })

  test('cannot displace a guest that is already bound', () => {
    const d = healthy({ wantedUid: 'UID_EMAIL', wantedIsUpgraded: true })
    expect(d.status).toBe('not_a_guest')
    expect(d.write).toBe('none')
    // The answer still names the device's real guest, so the caller can go and
    // ask for it properly.
    expect(d.uid).toBe('UID_A')
  })

  test('is refused whatever else is true of it', () => {
    for (const wantedUserExists of [true, false]) {
      for (const secretMatches of [true, false]) {
        for (const callerIsBoundUid of [true, false]) {
          const d = healthy({
            wantedUid: 'UID_EMAIL', wantedIsUpgraded: true,
            wantedUserExists, secretMatches, callerIsBoundUid,
          })
          expect(d.status).toBe('not_a_guest')
          expect(d.write).toBe('none')
        }
      }
    }
  })

  test('asking with no uid at all is unaffected', () => {
    // `wantedIsUpgraded` is meaningless without a uid, and must not leak into
    // the plain question.
    const d = ask({ wantedUid: '', wantedIsUpgraded: true })
    expect(d.status).toBe('no_guest')
  })
})

// ── CASE 12: the guest who added a phone or Google ───────────────────────────

describe('a guest account that has grown into a full one', () => {
  test('keeps its binding, so the handset gets no second guest', () => {
    /*
     * Releasing the binding here looks tidy and is a reward farm: upgrade,
     * release, collect a new guest's starting balance, repeat, on one handset.
     */
    const d = healthy({ boundIsUpgraded: true, wantedUid: 'UID_NEW' })
    expect(d.status).not.toBe('bound')
    expect(d.write).toBe('none')
  })

  test('but is not handed out to whoever is holding the phone', () => {
    /*
     * The other half. The binding exists to rescue an account with no other way
     * back; this one has Google or a phone, so "Continue as guest" is not a
     * second door into it — otherwise a sign-out leaves it open to the next
     * person who picks the handset up.
     */
    const d = healthy({ boundIsUpgraded: true })
    expect(d.status).toBe('upgraded')
    expect(d.uid).toBe('UID_A')
    expect(d.write).toBe('none')
  })

  test('and the owner themselves is not locked out of it', () => {
    // A verified token for that very uid. Refusing here would sign somebody out
    // of their own session as a reward for having upgraded it.
    const d = healthy({ boundIsUpgraded: true, callerIsBoundUid: true, wantedUid: 'UID_A' })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })
})

// ── Device bans ──────────────────────────────────────────────────────────────

describe('a barred handset', () => {
  test('is refused a NEW guest account', () => {
    const d = ask({ deviceBanned: true, wantedUid: 'UID_NEW' })
    expect(d.status).toBe('device_banned')
    expect(d.write).toBe('none')
  })

  test('can still be told its existing account, which resolveIdentity then refuses', () => {
    /*
     * Deliberate, and the reason is single ownership of the rule: resolveIdentity
     * decides what a restricted account or a barred device is told, and bars the
     * device again on the way past. Refusing here as well would put the ban
     * message in two places, and the wrong one would be this one — it cannot see
     * a suspension that has expired.
     */
    const d = healthy({ deviceBanned: true })
    expect(d.status).toBe('existing_guest')
    expect(d.uid).toBe('UID_A')
  })

  test('the ban is not silently downgraded into a plain refusal', () => {
    // A `no_guest` here would send the client off to create an account.
    const d = ask({ deviceBanned: true, wantedUid: 'UID_NEW' })
    expect(d.status).not.toBe('no_guest')
  })
})

// ── What actually gets written ───────────────────────────────────────────────

describe('the document a binding writes', () => {
  test('a FIRST binding carries no replacement keys at all', () => {
    /*
     * THE BUG THESE TESTS MISSED, AND IT SHIPPED.
     *
     * The absent keys used to be written as `FieldValue.delete()`. That sentinel
     * is legal only in `update()` or in `set()` with `{merge: true}`; in the
     * plain `set` this goes into, the SDK throws, and a thrown non-HttpsError
     * reaches the caller as the opaque code INTERNAL.
     *
     * Which path hit it? `boundUid === ''` — no binding yet — i.e. the first
     * guest on every new handset. The commonest path in the whole feature,
     * failing with "internal error" and nothing to explain it, while 26 tests of
     * the decision logic passed. The decision was right; nobody tested the three
     * lines that wrote it down.
     */
    const d = ask({ wantedUid: 'UID_NEW' })
    const payload = bindingPayload(d, '')
    expect(payload).toEqual({ uid: 'UID_NEW' })
    expect(Object.keys(payload)).toHaveLength(1)
  })

  test('a replacement records what it displaced, and why', () => {
    const d = healthy({ boundUserExists: false, wantedUid: 'UID_FRESH' })
    expect(bindingPayload(d, 'UID_A')).toEqual({
      uid: 'UID_FRESH',
      replaced: 'UID_A',
      replacedReason: 'account_purged',
    })
  })

  test('every value written is a plain string — no sentinels, ever', () => {
    // The property that would have caught it. A Firestore sentinel is an object;
    // anything non-string here is something `set` may refuse at runtime.
    for (const previousUid of ['', 'UID_A']) {
      const d = healthy({ boundUserExists: false, wantedUid: 'UID_FRESH' })
      for (const [key, value] of Object.entries(bindingPayload(d, previousUid))) {
        expect(typeof value).toBe('string')
        expect(key).not.toBe('')
      }
    }
  })
})

// ── The invariant, stated directly ───────────────────────────────────────────

describe('the invariant', () => {
  test('no input with a live bound account ever produces a bind', () => {
    /*
     * Exhaustive over the flags that could plausibly reach the create path with
     * a live account bound. `bind` in any of these is a second guest account on
     * one device, which is the whole thing this function exists to prevent.
     */
    let checked = 0
    for (const secretMatches of [true, false]) {
      for (const deviceBanned of [true, false]) {
        for (const wantedUid of ['', 'UID_A', 'UID_X']) {
          for (const bindingAgeMs of [0, 1_000, OLD]) {
            for (const callerIsBoundUid of [true, false]) {
              for (const boundIsUpgraded of [true, false]) {
                for (const wantedUserExists of [true, false]) {
                  for (const wantedIsUpgraded of [true, false]) {
                    const d = decideGuestClaim({
                      deviceBanned,
                      boundUid: 'UID_A',
                      secretMatches,
                      boundUserExists: true,
                      boundIsUpgraded,
                      bindingAgeMs,
                      wantedUid,
                      wantedUserExists,
                      wantedIsUpgraded,
                      callerIsBoundUid,
                    })
                    expect(d.write).not.toBe('bind')
                    // And whatever it decides, it is about UID_A or about nothing.
                    if (d.uid !== '') expect(d.uid).toBe('UID_A')
                    checked++
                  }
                }
              }
            }
          }
        }
      }
    }
    // Asserted so that a flag added to the input without a case added here shows
    // up as a failing count rather than as silently unexercised combinations.
    expect(checked).toBe(576)
  })

  test('a token is only ever offered for the uid that is actually bound', () => {
    for (const wantedUid of ['', 'UID_A', 'UID_B']) {
      const d = healthy({ wantedUid })
      if (d.status === 'existing_guest') expect(d.uid).toBe('UID_A')
    }
  })
})

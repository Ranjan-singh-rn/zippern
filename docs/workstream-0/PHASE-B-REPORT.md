# ZIPPER — Workstream 0, Phase B

## Quick Login: device binding, rotation and account state

**Status line (§25):**

> **PHASE B COMPLETE — READY FOR REVIEW**

This report was first delivered as **BLOCKED**, on A5: the unauthenticated appeal
path, approved in Phase A and never built. A5 is now built (§9), so the blocker is
gone. Two caveats stand and are not hidden — no Kotlin compiler and no Firestore
emulator in this environment (§11).

Reading A5 up close turned up something worse than the gap I had reported, and it
is the first thing in §9.

---

## 1. What Quick Login now means

> Log back into the account that was most recently signed out **from this
> physical device**.

Not a persistent login, not a password, not account recovery, and not
transferable. Each property below is enforced somewhere specific.

| Required property | Where it is enforced |
|---|---|
| Device-bound | EC P-256 keypair generated **inside the Android Keystore**; public half registered at mint, signature over a server nonce demanded at redemption |
| Account-specific | the credential document holds one `uid`; nothing selects an account by device id |
| Securely stored | private key non-exportable and not in any backup; server keeps only `sha256(secret)` |
| Server-verifiable | `crypto.verify('sha256', …, {dsaEncoding:'der'})` against the registered key |
| Revocable | by the owner (`revokeQuickLogin`), by deletion (`revokeQuickLoginOnRestriction`), by displacement, and by "forget this device" — which destroys the Keystore key, not just the bytes |
| Rotatable | consumed and replaced on every successful redemption |
| State-aware | device ban → ban → deletion → suspension, in that order |
| Non-transferable | Block Store cloud backup **off**, and the Keystore key cannot travel even if the bytes do |

---

## 2. The hole that was actually there

Before this phase the credential was a **400-day bearer secret**:

- redeemed by an unauthenticated callable whose handler took no `context` at all;
- it recorded a `deviceId` — `Settings.Secure.ANDROID_ID`, chosen and sent by the
  client — and **never compared it with anything**;
- a successful redemption only stamped `lastUsedAt`, so the same secret worked
  again, and again, from anywhere;
- and `QuickLoginStore` stored it with `setShouldBackupToCloud(true)`, which is a
  channel built for moving exactly those bytes onto the next handset.

So the credential *was* its bytes, and the bytes were designed to travel. A device
id cannot be a security boundary, because the client picks it.

---

## 3. What replaced it

### Three steps, and the middle one is the point

```
1. client asks for a challenge      quickLoginChallenge()      — random, single-use, 2 min
2. client signs it                  DeviceKey.sign()           — private half never leaves the Keystore
3. client redeems                   redeemQuickLogin({token, challengeId, signature, deviceId})
4. server verifies the signature against the key registered at mint
5. server applies account state
6. server rotates the credential and returns a custom token
```

A secret lifted onto a second handset — by cloud backup, device transfer, or off a
rooted filesystem — arrives at step 3 **without the key that signs for it**, and
authenticates nothing.

### Ordering that is itself a security property

The signature is checked **before** the account is read. A caller who cannot prove
possession of the device learns nothing about whether the account behind the secret
exists, is banned, or is suspended. `quickLoginWiring.test.js` pins this: a bad
signature over a banned account reports `refused`, not `banned`.

### Rotation

A redemption destroys the credential it spent and writes its replacement. A
captured secret is worth one race against the real holder, not a month of quiet
access. The Android side saves the replacement **before** opening the session,
because the old one is already dead.

### Numbers

| | was | now |
|---|---|---|
| Credential life | 400 days | **30 days** |
| Challenge life | — | **2 minutes**, single-use |
| Failures per binding | unlimited | **5**, then a 15-minute cool-off |
| Uses per credential | unlimited | **1** |

---

## 4. §12 — the transfer channel, closed

`QuickLoginStore.kt` now passes `setShouldBackupToCloud(false)`.

This is defence in depth rather than the whole defence: the Keystore binding is
what makes a travelled credential useless. But shipping both halves of the old
hole had no argument for it.

**`DeviceSecretStore.kt:229` still passes `true`, deliberately — see §10.3.**

---

## 5. Account state at redemption

`quickLoginPolicy.accountVerdict`, in this order, and the order is the rule:

| State | Outcome | Credential | Session | Appeal | Message |
|---|---|---|---|---|---|
| Device banned | `device_banned` | **kept** | no | no | "Your device is banned. Contact the support for removing ban." |
| Banned | `banned` | **kept** | no | **yes** | the ban reason, or the standard ban sentence |
| Deleted / recovery window | `deleted` | destroyed | no | no | generic |
| Suspended | `suspended` | **kept** | no | **yes** | the suspension, with its end date |
| Otherwise | `allow` | rotated | yes | n/a | — |

Four deliberate non-obvious choices:

- **A ban keeps the credential.** The A5 fix — §9 is entirely about why.
- **`device_banned` keeps it.** The handset is barred, not the credential. A lifted
  ban should find it still there.
- **`rate_limited` keeps it.** A cool-off that destroyed the credential would turn
  five wrong attempts into a permanent loss.
- **Only deletion destroys it.** Recovery is its own flow with its own proof, and
  there is no appeal against a deletion the person asked for.

Distinct messages per cause, per the earlier decision: an account ban travels with
the person and a device ban travels with the handset, and somebody told the wrong
one takes the wrong action. Everything else collapses to one neutral sentence so a
failed probe reveals nothing.

---

## 6. §7 — displacement is not a restoration path

Three separate things had to be true:

1. `SessionViewModel.tearDownSession` passes `signOut(mintQuickLogin = false)`, so
   a displaced handset does not mint itself a credential on the way out.
2. `startMobileSession` **revokes** the displaced device's existing credentials.
3. `startMobileSession` stamps `credentialsValidAfter` so the displaced device's
   direct Firestore writes are refused by `sessionCurrent()` in the rules.

---

## 7. §21 — the same-second case was real, and wider than suspected

The specification asked for this test explicitly and said not to weaken it. Good,
because it found something.

The first implementation stamped `credentialsValidAfter = now - 5 seconds`, because
`auth_time` is set when Firebase mints a credential, a moment before the function
runs, and without slack a device raced its own stamp.

**Slack is a window.** For five seconds after Phone B signed in, Phone A's older
token still satisfied the comparison and kept writing — and "switching phones" is
precisely the two-sign-ins-seconds-apart case the window was open for.

**Fixed** by stamping the caller's own `auth_time` rather than a wall-clock guess.
`credentialCutoff.test.js` holds both: `FIVE SECONDS APART` is the case the old
stamp let through, and `the displacing device is never locked out by its own stamp`
is the failure the slack existed to prevent.

**The residual limit, stated rather than hidden:** `auth_time` has **one-second
granularity**. Two devices authenticating inside the same clock second are
indistinguishable *at that layer*, and `sameSecondExactly` asserts that plainly.
What covers it is the mobile-session check — session ids are random 128-bit values
with no resolution limit, so two sign-ins in the same microsecond still produce
different ids and the displaced one does not match.

---

## 8. §13 — legacy credentials

A legacy credential has no version and no registered public key, so there is
nothing to verify a signature against — and it is **not upgradeable in place**,
because the device's Keystore key did not exist when it was minted. No proof of
possession can be constructed for it after the fact.

So: refuse it, clear it from the device, and let one ordinary sign-in produce a
credential that satisfies the model. Three places cooperate:

- server returns `legacy` with "Please sign in once to re-enable quick sign-in on
  this device."
- `refuseQuickLogin` clears the local copy on that detail code;
- `savedQuickLogin()` returns null when the handset has no key at all, so the
  button is hidden *before* the tap rather than vanishing after it.

**The guest path needed its own answer.** `signInAsGuest` now gates on
`savedQuickLogin()` rather than `quickLogin.load()`. Taking that branch with an
unusable credential would spend a guest's one chance on a redemption certain to
fail — and a failed resume is terminal by design — so they would be told to "sign
in once" when they have no other way in. Skipping it falls through to
`claimGuestIdentity`, which recovers the device's guest from the device secret and
needs no key. **Legacy credentials therefore cost a guest nothing.**

---

## 9. A5 — the appeal that needs no session

### 9.1 The thing I got wrong, stated first

The first version of this report said Phase B had broken the appeal for *suspended*
accounts reaching the app through quick login. That was true and it was the small
half of the problem.

The large half: **A4 — which I shipped in Phase A — had already broken the appeal
for every banned account, on every path.**

`backend/app/db/firebase.py::set_user_disabled` does two things, and its own
docstring says why both are needed:

> `disabled=True` refuses NEW sign-ins. It does not invalidate an ID token already
> issued … `revoke_refresh_tokens` sets the cutoff that makes the existing one
> unacceptable too.

`ban_user` calls it. So a banned account's session is dead within the second.
Meanwhile `AppealRepository.kt` still opened with this, as its stated design:

> "`isBanned` gates the PRODUCT, not the session. A banned person is still signed
> in — **which is what makes this possible at all**."

That premise stopped being true the moment A4 shipped, and the appeal form it holds
up is an authenticated Firestore write (`raisedByUid == request.auth.uid`). On top
of that, `revokeQuickLoginOnRestriction` destroyed the quick-login credential on
ban as well — so a banned person held **no session, and no credential, and no way
to say they had been banned by mistake**.

A5 was not an unfinished nicety. A4 created the need for it, and I shipped A4
without it.

### 9.2 What identifies an appellant with no credentials

The same proof redemption uses: an **EC P-256 signature over a server-issued,
single-use challenge**, from the key in this handset's Keystore, registered against
the credential at mint.

That is a stronger claim than a session. A session says *somebody holds a token for
this account*. This says *somebody is holding the physical device this account was
last signed out from* — and the private half cannot be exported, backed up, or
restored onto another phone.

### 9.3 What changed to make it possible

| Change | Why |
|---|---|
| `destroysCredential` → **deletion only** | Ban and suspension keep the credential. It is the only identifier left, and it grants nothing. |
| `revokeQuickLoginOnRestriction` → **deletion only** | Was destroying the proof the policy says to keep. Second time this trigger has had to be narrowed; now pinned to `destroysCredential` outcome-by-outcome. |
| `mintQuickLoginToken` no longer refuses a banned account | It refused on the reasoning that a banned account may not arrange its own way back in. Right reasoning, wrong conclusion: the credential is no longer a way back in. It mattered most for somebody banned **mid-session**, whose app tears down and mints on the way out, and who would otherwise reach the ban screen holding nothing. |
| `redeemQuickLogin` returns `banned` as a **payload**, not an error | So the app can render the ban, the reason and the appeal state from one response. Symmetrical with `suspended`. |

Nothing here grants access. Three independent locks remain: `grantsSession` is
false for both states, no custom token is ever minted, and the Firebase login stays
disabled by the CRM's own action.

### 9.4 `submitAccountAppeal`

An unauthenticated callable. In order:

1. **statement validated first** — before the challenge is consumed. A statement
   that is too short is the one error a person can fix by retyping, and burning
   their single-use challenge on it would make them request another they cannot see.
2. challenge consumed in a transaction; signature verified against the registered key
3. `permitsAppeal(outcome)` — **ban and suspension only**. `allow` is refused too: an
   unrestricted account has nothing to appeal, and accepting it would put noise in
   the queue ahead of real appeals.
4. one pending appeal per account, checked server-side (the client's check needed a
   session)
5. written with the Admin SDK — which is what bypasses the rules' `auth.uid`
   requirement — using **exactly** `appealFields()` from `firestore.rules`, so the
   CRM reads one shape whichever route an appeal arrived by
6. `status: 'pending'`. The verdict still comes from
   `POST /users/appeals/{id}/decide`, audited, with the four-eyes check intact.

**The device ban is deliberately not consulted.** `deviceBanned: false` is passed on
purpose: a barred handset and a banned account are different facts, and refusing to
hear about the second because of the first would mean the people under the most
moderation are the ones who cannot appeal any of it. Nothing is weakened — the
signature still has to verify and the state still has to be appealable.

**The statement text is not copied into the audit event.** Only `statementChars`.
Somebody's account of what happened to them belongs in the appeal document, where a
reviewer reads it, not in a second place with different retention.

**No evidence files on this path.** Cloud Storage rules need a signed-in caller and
there is none. The statement is the part a reviewer reads, and a half-working upload
would be worse than none.

### 9.5 The residual gap, named

A person needs **the credential and the key** to appeal this way. Somebody who
cleared Block Store, or reinstalled after being banned — a reinstall mints a new
Keystore key, so the old credential cannot be signed for — has neither.

There is nothing the app can do about that, so it says so and points at support,
rather than failing with something that sounds retryable. Everyone who has signed
in since this ships holds a credential before any ban can happen, because
`mintQuickLoginCredential` runs on every successful sign-in — so the gap is
confined to people banned *before* this ships who have since wiped the device.

---

## 10. Other findings — reported, not acted on

### 10.1 `notBanned()` does not cover suspension *(pre-existing)*

```
function notBanned() {
  return request.auth != null
         && get(/databases/$(database)/documents/users/$(request.auth.uid))
              .data.get('isBanned', false) != true;
}
```

A suspended account holding a live Firebase session passes `isActiveAppUser()` and
may write directly to Firestore wherever that is the gate. The backend's
`assert_may_act` (Phase A) 403s them on FastAPI endpoints, and client navigation
holds them on SuspendedScreen — but neither of those is in the path of a direct
Firestore write. **Not changed:** it is a moderation clause, and the do-not-modify
instruction covers it.

### 10.2 A compile error left by Phase A

`signOut` called `mintQuickLoginCredential(deviceId)` while the function was still
named `mintQuickLogin` — I renamed the call site to dodge shadowing by the
`mintQuickLogin: Boolean` parameter and never renamed the function. **The Android
module would not have compiled.** Fixed; all five call sites now agree.

Worth saying plainly: this survived because Kotlin cannot be compiled in this
environment. It is the clearest available evidence for how much weight §11's
caveat deserves.

### 10.3 `DeviceSecretStore` is still cloud-backed, and that is a real exposure

`DeviceSecretStore.kt:229` passes `setShouldBackupToCloud(true)`. That secret buys
a **custom token** — a full session — for a guest account, via
`claimGuestIdentity`. It is a bearer secret with no signature requirement, and it
is deliberately synced for device transfer.

So the hole Phase B closed for Quick Login **is still open one door down**, for
guest accounts specifically.

**Not changed, on purpose.** It is a different feature with a different documented
promise — "a guest identity belongs to the DEVICE", and carrying it across a
transfer is the point — and silently breaking that would strand guest accounts,
which is the exact bug that system was built to prevent. Closing it properly means
giving the guest secret the same signature binding, which is new scope and a
business decision about whether guest accounts should survive a device transfer at
all. **Flagged for Phase C or a decision.**

### 10.4 `revokeQuickLoginOnRestriction` contradicted the policy, twice

First pass: it destroyed credentials on ban, deletion **and suspension**, while
`destroysCredential` kept suspension. Narrowed to ban and deletion.

Second pass, once A5 showed that a ban must keep the credential too: narrowed again
to **deletion only**. Having to narrow the same trigger twice is the argument for
the test that now pins it to `destroysCredential` **outcome by outcome** rather
than as two lists that happen to agree today.

### 10.5 `appeals` had no composite index, and `myAppeals()` has probably never worked

`AppealRepository.myAppeals()` runs:

```kotlin
.whereEqualTo("subjectUid", uid).orderBy("createdAt", DESCENDING)
```

Equality plus `orderBy` on a different field requires a composite index, and
`firestore.indexes.json` declared none for `appeals` — 42 indexes, none of them
this one. The call is wrapped in `catch { emptyList() }`, so it would have failed
silently and the banned screen would never show what came of a past appeal.

Added the index. Separately, `appealStateFor` is built so the part that **must**
work does not depend on it: the pending check is equality-only (`subjectUid` +
`status`), which Firestore serves by merging single-field indexes. Only the
"what came of your last appeal" read needs the composite one, and a missing index
there costs a sentence rather than the dedupe.

### 10.6 Two collections would have grown without bound

`quickLoginChallenges` gets one document per tap; `quickLoginRate` one per failing
binding. The old sweeper handled only `quickLoginTokens`, and with a single
`limit(500)` per day, which is not a sweep for a collection that grows per tap.
Rewritten: all three collections, batched, bounded at 4,000 documents per run.

---

## 11. Verification — exactly what was and was not run

### Run, green

| Suite | Pass | Fail |
|---|---|---|
| `functions/test/quickLoginPolicy.test.js` | **33** | 0 |
| `functions/test/quickLoginWiring.test.js` | **66** | 0 |
| `functions/test/quickLoginSignature.test.js` | **11** | 0 |
| `functions/test/mobileSession.test.js` | **14** | 0 |
| `functions/test/credentialCutoff.test.js` | **9** | 0 |
| `functions/test/pricing.test.js` | **66** | 0 |
| `functions/test/crmRoles.test.js` | **36** | 0 |
| `functions/test/guestBinding.test.js` | **34** | 0 |
| `functions/test/backfillPublicSellers.test.js` | **27** | 0 |
| `functions/test/publicSeller.test.js` | **22** | 0 |
| `functions/test/phone.test.js` | **15** | 0 |
| `functions/test/hostGuards.test.js` | **14** | 0 |
| `functions/test/party.test.js` | **9** | 0 |
| **TOTAL** | **356** | **0** |

- `functions`: `npx tsc --noEmit` — **clean**; `npm run build` — **clean**
- `zipper-crm`: `npx tsc --noEmit` — **clean**, and the CRM references none of the
  quick-login surface (verified by grep: zero hits for `quickLogin`,
  `credentialsValidAfter`, `authEvents`)
- `firestore.rules`: brace and parenthesis balance verified (254/254, 835/835)

### Mutation testing — 36 of 36 regressions caught

The point of running these is that a test suite nobody has tried to break is a suite
of unknown value. Each mutation was applied, the suites run, the mutation reverted.

**Phase B (13)** — cloud backup switched back on · challenge sweep removed ·
rate-record grace period removed · credential sweep given a day of grace · account
checked before the signature · detail code no longer sent · public key not required
at mint · device signature step dropped · rotation guard made dead (`if (false)`) ·
rate limit made to destroy the credential · mint no longer refuses without a key ·
ordinary sign-out starts forgetting the device · forget-this-device leaves the key
alive.

**A5 (19)** — ban destroys the credential again · trigger fires on ban again ·
appeal permitted for a healthy account · appeal signature check dropped · appeal
mints a session · appeal gate inlined instead of `permitsAppeal` · statement
validation removed · statement validated after the challenge is consumed ·
statement text copied into the audit event · appeal written already decided · a
field dropped from the appeal write · refused appeals stop counting to the limit ·
appeal consults the device ban · statement minimum dropped to zero · statement
maximum removed · Android loses its session-less fallback · Android session check
moved before the length check · Android appeal skips the device-key check · banned
arm clears the credential again.

**The signing mutations (4)** — appeal signs a constant · appeal sends a challenge
id it did not sign · redemption signs a constant · redemption sends a mismatched
challenge id.

### Five tests were strengthened rather than five mutations softened

Each of these started as a **MISSED**, which is the only reason they are now worth
anything:

1. **`rateCutoff` asserted file-wide.** A mutation changed the sweep argument to
   `now` while leaving the declaration in place, and the test passed. Pinned to the
   call.
2. **Rotation order asserted text order only.** A guard mutated to `if (false)` left
   the call in the right place and saved nothing. The condition is pinned too.
3. **`indexOf` returns -1, and `-1 < anything`.** Every ordering assertion in the
   file passed when its *first* step was deleted outright — removing the statement
   check entirely left "validated before the challenge is consumed" green. All of
   them now go through a `posOf` helper that throws on a missing marker.
4. **An ordering test compared a constant's declaration with a use 500 lines away.**
   `MIN_STATEMENT` first appears in the companion object at the top of the file, so
   the check was meaningless. Scoped to the function body.
5. **Nothing asserted *what* gets signed.** Signing a constant keeps every ordering
   assertion green and breaks every redemption and every appeal. Both call sites
   now pin `deviceKey.sign(challenge.challenge)` and the matching `challengeId`.

Two of those five (3 and 5) were latent in the Phase B suite I had already reported
as green. They are the clearest argument in this report for running mutations rather
than counting passes.

### NOT run — and not pretended otherwise

1. **No Kotlin compilation.** No Android SDK and no Gradle in this environment.
   Every change in `AuthRepository.kt`, `MoneyFunctions.kt`, `QuickLoginStore.kt`,
   `DeviceKey.kt`, `AuthViewModel.kt` is **implemented but unverified**. §10.2 is
   what that risk looks like in practice. Hand-checked instead: all call sites of
   every changed signature, no manual `AuthRepository(` construction (Hilt only),
   no destructuring of `MoneyFunctions.Result.Failed` that the added third field
   could disturb, `DeviceKey` is `@Singleton @Inject constructor()`.

2. **No Firestore emulator, so no rules were executed.** The rules tests are
   **models pinned to the extracted rule text** — a change to the rule without a
   change to the model fails loudly, which is worth something, and it is *not*
   equivalent to running the rules engine. Four new blocks are text-verified only:
   `quickLoginTokens`, `quickLoginChallenges` and `quickLoginRate` are
   `read, write: if false`; `authEvents` is `read: if isStaff()`, `write: if false`.
   The `appeals` rules are **unchanged** — A5 writes with the Admin SDK, which
   bypasses them, which is the point.

   **The new `appeals` composite index has not been built.** Declaring it in
   `firestore.indexes.json` is not deploying it, and nothing here deploys. Until it
   is built, `appealStateFor`'s "what came of your last appeal" read will throw and
   be swallowed; the pending-check does not depend on it (§10.5).

3. **Backend Python suite not re-run.** PyPI is blocked from this sandbox, so
   pytest cannot be installed, and the repo's `.venv` is a macOS venv that will not
   execute here. **Verified instead that no backend file changed:** the newest
   `backend/**/*.py` mtime is `19:58:35 UTC` and the earliest Phase B edit is
   `20:05:59 UTC`. The last green run — `test_money_permissions.py` 271,
   `test_auth_hardening.py` 80 — therefore still describes the current backend
   code.

4. **Nothing deployed, nothing migrated, no production data touched.**

### A note on the `[source]` tests

39 of the 66 checks in `quickLoginWiring.test.js` are labelled `[source]`: they read
a file and assert on its text. They are **not** equivalent to running the thing.

What they buy is narrow and worth stating — they catch somebody changing one side of
a two-sided agreement and not the other, which is a real class of bug and the one
this work produced three times (§10.2, §10.4 twice). They cannot catch a mistake
that is spelled correctly. All of them strip comments first, because these files
document what they *used* to do and a test satisfied by prose about a rule is not a
test of the rule.

---

## 12. §19 — what was not touched

A5 touched moderation adjacently, so it is worth being precise about what did and
did not change. **No moderation rule changed.** What a ban does — disable the
Firebase login, revoke its tokens, hold the account out of the product — is exactly
what it did before. The only change is that a banned person keeps the one thing
that lets them *say something about it*, and that thing grants no access.


Verified unmodified: roles and permissions, the progressive commission engine,
agency and sub-agency hierarchy, recharge, withdrawal, gifting, calls, wallet
economics, salary and payroll, support, livestream, games, reconciliation, the CRM
role model, and the Owner/Observer architecture. The only moderation-adjacent
change is §10.4, which **narrowed** a trigger to match an existing policy function
rather than changing any moderation rule.

---

## 13. Files

**Changed**

```
firestore.rules                                    4 collection blocks added
firestore.indexes.json                             appeals composite index (§10.5)
functions/src/quickLoginPolicy.ts        new     pure, no imports; + permitsAppeal,
                                                 isReportableState, statementProblem
functions/src/quickLogin.ts              new     redemption + submitAccountAppeal
functions/src/identity.ts                        old callables removed; displacement
                                                 revocation; auth_time stamp; sweeper;
                                                 restriction trigger → deletion only
functions/src/index.ts                           exports
zipper-app/.../util/DeviceKey.kt         new     162 lines, Keystore EC P-256
zipper-app/.../util/QuickLoginStore.kt           cloud backup off
zipper-app/.../repository/MoneyFunctions.kt      4 callables, detail codes
zipper-app/.../repository/AuthRepository.kt      redemption flow, refusal handling,
                                                 mint rename, guest path, forget-device
zipper-app/.../repository/AppealRepository.kt    session-less appeal route
zipper-app/.../auth/AuthViewModel.kt             doc comments
zipper-app/.../auth/SessionViewModel.kt          displacement mints nothing
```

**Tests**

```
functions/test/quickLoginWiring.test.js      66   new this phase
functions/test/quickLoginPolicy.test.js      33
functions/test/quickLoginSignature.test.js   11
functions/test/credentialCutoff.test.js       9
```

---

## 14. Open items

Nothing blocks review. These want decisions or an environment I do not have.

1. **A decision on §10.3** — should the guest device secret get the same signature
   binding, accepting that guest accounts would no longer survive a device
   transfer? A product question about guests, not a security one. The hole Phase B
   closed for Quick Login is still open one door down until this is answered.
2. **§10.1 wants a Phase D/E item** — `notBanned()` ignores suspension, so a
   suspended account holding a live session passes `isActiveAppUser()` in the
   rules. Pre-existing, and a moderation clause I was told not to touch.
3. **An Android build** somewhere that can compile, before any of this ships.
   §10.2 is what the absence of one costs.
4. **Deploy the `appeals` index** before relying on the "what came of your last
   appeal" text. Declared, not built.
5. **Consider updating `AppealRepository`'s doc heading in the CRM's own docs** —
   the stale premise there ("a banned person is still signed in") is the kind of
   comment that makes the next person reason from a fact that stopped being true
   two phases ago. The file itself is corrected; Phase 0's §-docs are not.

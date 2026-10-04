# ZIPPER — Phase B Verification & Deployment Readiness

**Verification pass only. Nothing deployed, nothing migrated, no production data touched.**

---

## VERDICT

> ## NOT READY TO DEPLOY

Not because Phase B is wrong — the implementation verifies clean against its
report, 56 of 56 content claims, and the test position is materially stronger
than when the report was written. It is not ready because of three things that
have nothing to do with Quick Login's design:

| # | Blocker | Why it blocks |
|---|---|---|
| **B1** | **The code being deployed is not in version control.** `functions/`, `firestore.rules`, `firestore.indexes.json`, the backend and the CRM are **untracked** — not gitignored, never added. | No reviewable diff, no rollback point, no attribution, no CI. A security change that cannot be rolled back is not deployable. |
| **B2** | **`ENFORCE_MOBILE_SESSION` is unset, so production would not enforce one active session.** | The headline Phase-A control ships inert. |
| **B3** | **Android has never been compiled.** No SDK, no Gradle, no network, wrong JDK. | ~2,900 lines of changed Kotlin, unverified. Phase A already shipped one compile error through this gap (§3.3). |

B1 and B3 are environmental/process. B2 is a one-line config decision with a
documented rollout reason behind it. **None requires redesigning Phase B.**

---

## 1. The semantics, re-verified against the code

Treated as final and not changed. Each was checked mechanically; **56/56 passed.**

| Required property | Verified by | Result |
|---|---|---|
| device-bound | EC P-256 in `AndroidKeyStore`; `crypto.verify` SHA-256/DER; signature checked *before* account state | PASS |
| account-specific | one `uid` per credential document | PASS |
| non-transferable | `setShouldBackupToCloud(false)`; private half never exported | PASS |
| securely stored | server holds `sha256(secret)` only — proven by executing a mint and grepping the stored document | PASS |
| single-use | challenge consumed in a transaction; 2-minute TTL | PASS *(see §13.1 — holds sequentially, not concurrently)* |
| rotated | spent credential deleted, replacement written, old one proven dead | PASS |
| state-aware | device-ban → ban → deleted → suspended, order asserted | PASS |
| cannot bypass suspension/ban/deletion | executed: none mints a custom token | PASS |
| cannot restore a displaced session | teardown passes `mintQuickLogin = false`; `startMobileSession` revokes | PASS |

---

## 2. The actual diff

### Git cannot answer this question, and that is the finding

```
tracked files in the repo        79
  under zipper-app              70  (26 of 167 .kt files)
  under functions/src            0  (of 23)
  under backend                  0
  under zipper-crm               0
firestore.rules                 UNTRACKED
firestore.indexes.json          UNTRACKED
last commit                     7049cc1, 2026-06-20  (12 commits total)
```

None of it is gitignored — `git check-ignore` returns nothing. It was simply
never added. **Every security change from Phase 0 through Phase B exists only as
uncommitted files on one machine.**

The two Phase-B files that *are* tracked carry diffs of `+2623/−84` and
`+531/−57` against a June commit, so they contain all of Phase 0–B mixed
together. A diff-based review is not available at any granularity.

### So the diff was verified by content and modification time instead

Enumerating every non-cache file touched in the Phase-B window gives **exactly
17 code/config files + the report**, matching the report's list with **nothing
unexpected**:

**Expected and present (17/17)** — `firestore.rules`, `firestore.indexes.json`,
`quickLoginPolicy.ts`, `quickLogin.ts`, `identity.ts`, `index.ts`,
`DeviceKey.kt`, `QuickLoginStore.kt`, `MoneyFunctions.kt`, `AuthRepository.kt`,
`AppealRepository.kt`, `AuthViewModel.kt`, `SessionViewModel.kt`, plus
`quickLoginWiring/quickLoginPolicy/quickLoginSignature/credentialCutoff` tests.

**Unexpected changes:** none.

**Uncommitted changes:** all of it. That is B1.

---

## 3. Android compilation — attempted for real, and it cannot be done here

### 3.1 The exact command and the exact failure

```
$ cd zipper-app && ./gradlew assembleDebug --offline --no-daemon --console=plain
Downloading https://services.gradle.org/distributions/gradle-8.14.5-bin.zip
Exception in thread "main" java.io.IOException: Unable to tunnel through proxy.
        Proxy returns "HTTP/1.1 403 Forbidden"
        at org.gradle.wrapper.Install.forceFetch(SourceFile:2)
EXIT=1
```

`--offline` does not help: the wrapper must obtain the distribution before any
Gradle flag is read.

### 3.2 Four independent blockers, each fatal alone

| Requirement | Present | Evidence |
|---|---|---|
| Gradle 8.14.5 | **No** | `~/.gradle/wrapper/dists` holds only 0-byte `.part`/`.lck` files — 20 KB total, abandoned downloads, not a distribution |
| Android SDK (compileSdk 34) | **No** | `ANDROID_HOME` unset; no `sdkmanager`, no `adb`, no SDK directory |
| JDK 17 | **No** | JDK **11.0.32** only. Project declares `sourceCompatibility = VERSION_17`, `jvmTarget = "17"`; AGP 8.5.2 requires 17 |
| Network for AGP/deps | **No** | `services.gradle.org`, `dl.google.com`, `registry.npmjs.org`, `pypi.org` all return connection failure or 403 |

No dependency cache either (`~/.m2`, `~/.gradle/caches/modules-2` both absent).

Build variants are plain `debug`/`release`, no flavors, so there is no
authentication-specific variant to isolate.

> ### Android compilation remains unverified.

**Not caused by Phase B. Purely environmental.** The user's own SDK is at
`~/Library/Android/sdk` per `local.properties` — outside the folder this session
can reach.

### 3.3 What was done instead, and what it is worth

A symbol/signature resolution pass over the Phase-B Kotlin: **20/20 passed.**
Every `money.*`, `deviceKey.*` and `quickLogin.*` call site resolves to a
declared member; injected types are in the constructor, imported and
`@Inject`-constructible; all `AuthResult`/`RestrictionKind`/`Result` variants
used are declared; the Phase-A stale symbol (`mintQuickLogin` → 
`mintQuickLoginCredential`) is gone from all 7 call sites.

**This is not compilation.** It cannot see type inference, nullability,
generics, `when` exhaustiveness, Hilt graph validation, or Compose/KSP codegen.
Phase A's `mintQuickLoginCredential` error is the standing proof of what slips
through: it was a *name* error, the cheapest class there is, and it survived
review because nothing compiled.

**R8 is a second unverified surface.** Release sets `isMinifyEnabled = true`.
`proguard-rules.pro` keeps `com.zipper.app.data.**` — which covers the
repositories — but there is no keep rule for `com.zipper.app.util.**`, where
`DeviceKey` and `QuickLoginStore` live. They use no reflection, so direct
references should survive shrinking; that reasoning is not a release build.

---

## 4. Android instrumentation / manual Quick Login verification

**Not performed. No emulator, no device, no `adb`, and no compiled APK to install.**

Every scenario in §4 of the brief — normal logout, displacement, suspension,
ban, device-ban message, account switching — is **unverified on-device.**

What is now verified *at the server contract level*, by executing the real
handlers (§5.2): the state machine for all of those scenarios, including that
the device-ban sentence is distinct from the account-ban sentence, that neither
ban nor suspension mints a session, and that the appeal works in both states.
That covers what the server does. It does not cover what the screens do.

---

## 5. Firebase Functions

### 5.1 The repository's own scripts

```
$ npm run build     → tsc, exit 0
$ npx tsc --noEmit  → exit 0
$ npm test          → tsc && node --test "test/**/*.test.js"
```

| | |
|---|---|
| Total tests | **415** |
| Passed | **414** |
| Failed | **0** |
| Skipped | **0** |
| Todo | **1** *(a real defect, deliberately visible — §13.1)* |
| Suites | 84 |
| Build | **clean** |
| TypeScript | **clean** |

`zipper-crm`: `npx tsc --noEmit` **clean**, and it references none of the
quick-login surface (zero hits for `quickLogin`, `credentialsValidAfter`,
`authEvents`).

No unrelated test failed, so there is nothing to attribute to Phase B.

### 5.2 New this pass: the shipped handlers are now actually executed

The previous suite tested the *policy* and read *source text*. It never ran
`quickLogin.ts` — where the policy is composed with Firestore reads, challenge
consumption, rotation, rate limiting and audit.

Added `test/fakeFirestore.js` (an in-memory datastore) and
`test/quickLoginRuntime.test.js` — **59 tests, 58 pass, 1 todo** — which invoke
`quickLoginChallenge`, `mintQuickLoginToken`, `redeemQuickLogin`,
`revokeQuickLogin` and `submitAccountAppeal` from `lib/`, exactly as deployed,
with **real EC P-256 signatures over real server-issued challenges**, and assert
on what happens to the datastore.

Real: handlers, `crypto`, `admin.firestore.Timestamp`/`FieldValue`.
Fake: the datastore only. **It does not evaluate `firestore.rules`** — the Admin
SDK bypasses rules by design, so nothing here says anything about client
permissions.

---

## 6. Firestore emulator / rules

**Attempted. Not possible in this environment.**

```
$ npx --no-install firebase emulators:exec --only firestore "echo ok"
npm error 403 Forbidden - GET https://registry.npmjs.org/firebase
$ npm install --no-save @firebase/rules-unit-testing
npm error 403 Forbidden
```

`firebase-tools` is not installed, the npm registry is blocked, and no emulator
jar is vendored anywhere on disk. `firebase.json` *does* configure emulators
(firestore 8080, auth 9099, functions 5001, storage 9199, ui 4000) — the project
is set up for it; the environment cannot run it.

> ### Firestore rules remain unexecuted. No rule in this repo has ever been compiled.

The four Phase-B blocks are **text-verified only** (brace-balanced extraction,
not substring matching):

```
quickLoginTokens      { allow read, write: if false; }
quickLoginChallenges  { allow read, write: if false; }
quickLoginRate        { allow read, write: if false; }
authEvents            { allow read: if isStaff(); allow write: if false; }
```

Also text-verified: `sessionCurrent()` compares `request.auth.token.auth_time`
against `credentialsValidAfter`, and `credentialsValidAfter` appears on **both**
protected-field lists (so an account cannot zero its own cut-off).

`credentialCutoff.test.js` (9 tests) is a **model pinned to the rule text**, not
the rule. A change to one without the other fails loudly — worth something, and
not equivalent to the rules engine. **Everything in §6 of the brief that asks
for "actual enforcement" is unverified**, including displaced-session direct
writes.

---

## 7. The `appeals` composite index

| Check | Result |
|---|---|
| Declared in `firestore.indexes.json` | **Yes** — `subjectUid ASC`, `createdAt DESC` |
| Valid JSON, correct schema | **Yes** — 43 indexes, parses clean |
| Deployed to `zipper-83816` | **Cannot be determined** — no `firebase` CLI, no `gcloud`, no CLI credentials. `.firebaserc` `etags` is empty and `.firebase/` holds only two *hosting* caches from 30 Sep, no Firestore deploy record. |

> ### Index declared but not deployed (presumed — not verifiable from here).

Deployment command, when you choose to run it:

```bash
firebase deploy --only firestore:indexes --project zipper-83816
```

Index builds are additive and non-destructive. **Not run — the brief says
readiness, not mutation.**

**A pre-existing bug found while verifying this:**
`AppealRepository.myAppeals()` has always run
`whereEqualTo("subjectUid", …).orderBy("createdAt", DESC)` — which needs this
composite index — and no `appeals` index was ever declared. The call is wrapped
in `catch { emptyList() }`, so **it has most likely been silently returning
nothing since it was written**, and the banned screen has never shown the
outcome of a past appeal. Phase B's `appealStateFor` is built so the part that
*must* work (the pending-dedupe) uses an equality-only query needing no
composite index; only the "what came of your last appeal" sentence depends on it.

---

## 8. Functions deployment surface

Audited mechanically across all 23 `src/*.ts`.

| Check | Result |
|---|---|
| Functions defined | 54 |
| Defined but **not** exported (would silently not deploy) | **0** |
| Duplicate function names | **0** |
| Exports referencing a deleted function | **0** |
| Phase-B functions correctly defined, exported and regioned | **9/9** |

```
quickLoginChallenge            callable           asia-south1
mintQuickLoginToken            callable           asia-south1
redeemQuickLogin               callable           asia-south1
revokeQuickLogin               callable           asia-south1
submitAccountAppeal            callable           asia-south1   ← new (A5)
startMobileSession             callable           asia-south1
endMobileSession               callable           asia-south1
revokeQuickLoginOnRestriction  firestore trigger  asia-south1
sweepQuickLoginTokens          scheduled          asia-south1   30 4 * * *  Asia/Kolkata
```

The three old Quick Login callables are gone from both source and exports, so
`firebase deploy --only functions` will offer to delete them from the project.

Runtime: `engines.node = 22`, `firebase-functions ^4.8.0`, `firebase-admin
^12.0.0`, v1 API (`functions.region().https.onCall`). `firebase.json` has a
`predeploy` hook running `npm run build`, so a source change cannot ship stale
`lib/`. Consistent and correct.

### 8.1 A backwards-compatibility risk the report did not mention

`mintQuickLoginToken` and `redeemQuickLogin` **keep their names but change their
required arguments.** Any app build already on the estate will, after this
deploy:

- call `redeemQuickLogin({token})` with no challenge or signature → refused.
  Existing production credentials are all v1, so the refusal is `legacy` with
  *"Please sign in once…"*, which old clients treat as a definitive refusal and
  clear. **Graceful.**
- call `mintQuickLoginToken({deviceId})` with no `publicKey` →
  `invalid-argument`. The old client swallows that silently, so **un-updated
  clients permanently lose Quick Login** until they update.

Guests are not stranded: `claimGuestIdentity` + the device secret still recovers
a guest account, and that path is unchanged. This is a rollout-ordering
consideration, not a defect — but it should be a deliberate decision, not a
surprise.

---

## 9. Production configuration — B2

### `ENFORCE_MOBILE_SESSION`

| Question | Answer |
|---|---|
| Where is it read? | `functions/src/mobileSession.ts:81` — `=== 'true'` |
| Code default | **`false`** |
| Development value | **unset** |
| Staging value | **unset — there is no staging project** (`.firebaserc` has only `default: zipper-83816`) |
| Production value | **unset.** `functions/.env` exists and holds `SG_MAIL_KEY`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE` — and **not** this flag |
| Would production enforce one active mobile session? | **No.** |

> ### B2 — DEPLOYMENT BLOCKER, with a documented rollout reason.

The reason is in the code and it is sound:

> *"Every build currently on the estate calls these functions without a session
> id, so turning this on before the app ships would sign out every user on the
> platform at once."*

So the correct sequence is: ship the Android build that sends `sessionId` → wait
for it to become the minimum supported version → **then** set the flag. Until
that last step, Phase A's single-active-session rule is inert in production and
Phase B's displacement guarantees rest on a control that is switched off.

**Not changed.** Flagged for the rollout plan.

**Name mismatch worth fixing before anyone acts on it:** the comment at
`mobileSession.ts:43` says `ENFORCE_PRESENTED_SESSION`; the code reads
`ENFORCE_MOBILE_SESSION`. Someone following the comment would set a variable
nothing reads, see no change, and conclude the control was broken.

### Other configuration

| Item | State |
|---|---|
| Firebase project | `zipper-83816`, single project for dev/staging/prod |
| Region | `asia-south1` throughout, consistent |
| `OBSERVER_EMAIL` | set in `backend/.env`, **not** in `functions/.env` → functions fall back to the hardcoded `314zipper@gmail.com`. Happens to be correct; a hardcoded identity default in production regardless. Pre-existing. |
| `ACCOUNT_RECOVERY_DAYS` | unset → code default 60, matching the A8 decision |
| Secrets | via `functions/.env` (mode 600), not `functions:config()` |
| Phase-A/B feature flags | `ENFORCE_MOBILE_SESSION` is the only one |

---

## 10. Data / migration safety

**14/14 checks passed. No migration is required, and none is missing.**

| Property | Verified |
|---|---|
| A v1 record (no `version`, no `publicKey`) is classified `legacy` | PASS — and **executed** in the runtime suite |
| `legacy` short-circuits before the signature is even considered | PASS |
| `legacy` grants no session | PASS (executed: zero custom tokens minted) |
| `legacy` cannot file an appeal either | PASS (executed) |
| A forged `version` with no key is still refused | PASS (executed) |
| No server-side migration writes a key onto an old record | PASS |
| `writeCredential` always stamps the current version | PASS |
| Mint refuses without a real PEM, so no v2 record can exist without a key | PASS (executed) |
| Missing `expiresAt` / `lockedUntil` / `suspendedUntil` do not throw | PASS |
| Absent `credentialsValidAfter` means allowed — no flag-day lockout | PASS |
| The client clears a legacy credential locally | PASS (source) |

No old plaintext credential is silently accepted; no production document shape
causes a crash; **nothing destructive was run.**

---

## 11. Appeal flow (A5)

Verified **end to end against the shipped handler**, not modelled:

| Property | Result |
|---|---|
| Banned account can file; stored `status: 'pending'` | PASS |
| Suspended account can file | PASS |
| **Healthy** account cannot — `failed-precondition`, `not_restricted`, nothing written | PASS |
| Appeal never returns a session (zero custom tokens minted) | PASS |
| One pending appeal per account; a second returns `already_pending` | PASS |
| A *decided* appeal does not block a new one | PASS |
| Wrong-key signature refused, nothing written | PASS |
| Short statement refused **without burning the challenge** (so a typo costs nothing) | PASS |
| Over-long statement refused | PASS |
| Stored field set matches `appealFields()` in `firestore.rules` **exactly** | PASS |
| Audit event carries `statementChars`, never the words | PASS |
| A device ban does not block an account appeal | PASS |
| Credential retained through ban and suspension | PASS |
| Credential destroyed on deletion | PASS |

**Not verified:** that the CRM renders these appeals. The field set matches the
rules' allowlist, which is the strongest available proxy, but no CRM screen was
exercised.

---

## 12. Security regression — executed, not modelled

| Property | Status | How |
|---|---|---|
| Quick Login replay | **PASS** | spend a credential, spend it again → refused |
| Rotation | **PASS** | old secret dead, replacement live and immediately usable, same device key carried forward |
| Challenge single-use | **PASS** | consumed even when the attempt *failed*; expired refused; absent refused |
| Device transfer | **PASS** | signature from a different key refused — **and the real owner keeps their credential**, so a thief cannot burn it |
| Backup restore | **PASS** | same property: bytes without the Keystore key authenticate nothing |
| State bypass: suspended → active | **PASS** | reported, no token, credential kept, `canAppeal: true` |
| State bypass: banned → active | **PASS** | same, plus `reason` passed through |
| State bypass: deleted → active | **PASS** | refused, credential destroyed |
| Device ban outranks a healthy account | **PASS** | distinct message, verified ≠ the account-ban sentence |
| Device-ban lookup failure | **PASS** | **fails closed** |
| Rate limiting | **PASS** | 5 failures trip the cool-off; the 6th is `rate_limited`; checked *before* the credential so it cannot be probed around; a success clears it; a cool-off does **not** destroy the credential |
| Credential expiry / revocation honoured | **PASS** | added this pass (§15.2) |
| Ownership on revoke | **PASS** | a credential you do not own is not yours to retire |
| No secret persisted or logged | **PASS** | after a full redemption, no stored document in any collection contains either secret or the signature; audit events carry a 12-char SHA-256 prefix |
| One active mobile session | **sequential logic PASS**, **production enforcement OFF** | `sessionVerdict` (14 tests); see B2 |
| Displacement | **PASS (source + policy)** | teardown mints nothing; `startMobileSession` revokes |
| `credentialsValidAfter` not client-forgeable | **PASS (rules text only)** | on both protected lists; **unexecuted — no emulator** |
| Same-second login | **PASS as a model, with a stated limit** | `auth_time` has 1-second granularity, so the gate cannot separate two sign-ins in one second; the random 128-bit session id has no resolution limit and is what covers it. Verified behaviourally for `sessionVerdict`; the rules half is a model. |

---

## 13. New findings

### 13.1 Rotation is not atomic — `single-use` holds sequentially, not concurrently

**Found by executing the handler.** `credRef.get()` is a plain read outside any
transaction, and the subsequent `credRef.delete()` is unconditional. Two
redemptions of one secret carrying **different** challenges both read the
credential as live, both verify, and both succeed.

Measured:

```
successes             : 2
custom tokens minted  : 2
credentials remaining : 2   (expected 1)
orphaned credentials  : 1   ← live for 30 days, unreachable by the user
```

**What it is not:** an authentication bypass. Both attempts must produce a valid
signature, so only the holder of the Keystore key can cause it — the device
racing itself, not an attacker with a copied secret. `startMobileSession`
collapses the two sessions to one.

**What it is:** `single-use` not holding under concurrency, and a quiet violation
of "one device, one credential" — which `retireOthers` enforces at mint but
rotation does not. The orphan is never rotated and never cleaned until expiry.

**Severity: low. Not a deployment blocker.** Fix is small — rotate inside a
transaction on `credRef`, or call `retireOthers` after rotation. **Deliberately
not applied:** this pass is verification, not redesign. The failing expectation
is left in the suite as a `todo` so it stays visible, with a companion test that
asserts today's behaviour so a future fix breaks both and forces them to be
updated together.

### 13.2 `revokedAt` is dead defensive code

`credentialVerdict` refuses a credential with `revokedAt` set — but **no code
path ever sets it.** `revokeQuickLogin` and the restriction trigger both
*delete* the document, and `writeCredential` stamps `revokedAt: null`. The guard
defends against a shape only a manual CRM edit or a future soft-revoke would
produce. Harmless, and exactly the kind of guard that rots untested — it was
untested until this pass.

### 13.3 Plaintext secrets in `zipper-app/local.properties`

Correctly gitignored and untracked, but it holds the **Agora App Certificate**
and the **release keystore password** in plaintext. Anyone holding the Agora
certificate can mint an RTC token for any channel on the project.

**My environment probe printed that file into the session transcript.** Treat
both values as exposed and rotate the Agora certificate. Pre-existing, unrelated
to Phase B, and my disclosure — so stated plainly rather than buried.

---

## 14. Secret leakage — clean

| Check | Result |
|---|---|
| Raw Quick Login token logged | **None** |
| Device private key logged or persisted | **None** — no `getEncoded` on a private key; the only `toByteArray` in `DeviceKey` is on the *challenge* being signed |
| Challenge logged | **None** |
| Authorization header logged | **None** |
| Secret in analytics | **No analytics SDK integrated at all** |
| Secret in crash reports | **No Crashlytics integrated** (only stale `.idea` references to old build artifacts) |
| Secret in audit events | **None** — 12-char SHA-256 fingerprints only, proven by executing a redemption and inspecting every written document |
| Logging statements in `DeviceKey`, `QuickLoginStore`, `AppealRepository`, `MoneyFunctions` | **Zero** |
| ProGuard/R8 | Release minifies; `util.**` has no keep rule but uses no reflection. **Unverified without a release build** (§3.3) |

One pre-existing, low-severity note: `AuthRepository`/`AppealRepository` surface
raw `e.message` to the UI on several paths. Those exceptions come from Firebase
SDK calls, not from credential handling, so no secret flows there — but a raw
SDK message is a poor thing to show a user.

---

## 15. Test quality — the honest accounting

### 15.1 Source assertions are now the minority, and are labelled

| Category | Tests | What it proves |
|---|---|---|
| **Behavioural — shipped handlers executed** | **59** | `quickLoginRuntime` — real handlers, real signatures, datastore inspected |
| **Behavioural — pure modules** | **294** | policy, crypto, session, pricing, roles, phone, guest binding, … |
| **Source assertions** | **51** | `[source]`-labelled in `quickLoginWiring`; 28 concern **Android**, which has no runnable test harness here |
| **Model of `firestore.rules`** | **9** | `credentialCutoff` — pinned to rule text; **not** the rules engine |
| **Functions total** | **413** | 412 pass, 0 fail, 1 todo |
| Backend (standalone scripts) | **39 modules / 8,433 checks** | 0 failures; `test_auth_hardening` (80) and `test_money_permissions` (271) are **explicitly pinned source models** per their own docstrings |

`quickLoginWiring.test.js` breaks down as **15 behavioural + 51 source**. Many of
its server-side source assertions are now redundant against the runtime suite —
belt and braces, which is fine, but server-side coverage is now genuinely
behavioural rather than textual. The Android source assertions remain the only
option available.

### 15.2 Mutation testing, reported separately

**Phase-B + A5 mutations (previous pass): 36/36 caught.**

**New behavioural mutations this pass** — chosen so the *source* stays matching
every `[source]` assertion, so only an executed test can see them:

| | Count |
|---|---|
| Caught by the **runtime suite only** | **8** |
| Caught by both runtime and source | 2 |
| Rejected by `tsc` (not expressible) | 2 |
| Caught by neither | **1** → fixed, see below |

The eight the source assertions were blind to: rotation never deleting the old
credential · a suspended account handed a custom token · the pending-appeal
dedupe skipped · failures never incrementing · the rate limit checked but
ignored · `revokeQuickLogin` dropping its ownership check · mint no longer
retiring the previous credential · the challenge never marked used.

**That is the measured value of §5.2.** Eight ways the system could have been
broken while every pre-existing test stayed green.

**The one miss was a gap in my own tests, and it is closed.** Disabling the
`revokedAt` check broke nothing because no test ever seeded a revoked
credential. Two tests added (`revokedAt` set, and `expiresAt` in the past); both
previously-missed mutations are now caught. Strengthened the tests, not softened
the mutations.

---

## 16. What would make this deployable

1. **Commit the codebase.** `functions/`, `firestore.rules`,
   `firestore.indexes.json`, `backend/`, `zipper-crm/` — none is ignored, all is
   untracked. Until a reviewer can read a diff and an operator can roll back,
   nothing else on this list matters. **(B1)**
2. **Compile Android**, on a machine with JDK 17 + SDK 34 + network. Then run
   §4's device scenarios. **(B3)**
3. **Decide `ENFORCE_MOBILE_SESSION`** — confirm the rollout order (ship the app
   that sends `sessionId`, make it minimum-supported, then flip), and fix the
   `ENFORCE_PRESENTED_SESSION` comment so nobody sets the wrong variable. **(B2)**
4. **Stand up a staging project.** One Firebase project currently serves
   everything, so "test in staging before production" has no target — and the
   rules have never been compiled anywhere.
5. **Run the rules under the emulator** on a machine with `firebase-tools`. 51
   source assertions and a 9-test model are standing in for the rules engine.
6. **Deploy the `appeals` index** before relying on appeal history.
7. **Plan the old-client rollout** (§8.1) — un-updated builds lose Quick Login
   silently.
8. **Rotate the Agora App Certificate** (§13.3).

Optional, low priority: make rotation atomic (§13.1).

---

## 17. Scope discipline

- Nothing deployed. No migration. No production data read or written.
- No Phase-B semantics changed. No business rule invented.
- Changes made this pass, all test-only and additive:
  `functions/test/fakeFirestore.js` (new), `functions/test/quickLoginRuntime.test.js`
  (new). No `src/` file, no rules file, no Android file was modified.
- Every mutation applied during testing was reverted and the clean state
  re-verified: **415 tests, 414 pass, 0 fail, 1 todo.**

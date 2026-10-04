# ZIPPER — Git Baseline & Phase-B Blocker Resolution

**Nothing deployed. No production data touched. No reset, no clean, no discarded work.**
Only additive git operations were used: `git add`, `git rm --cached`, `git commit`.

---

## J. FINAL STATUS

> ## PHASE B BASELINE ESTABLISHED — READY FOR ANDROID/ENVIRONMENT VERIFICATION

The baseline exists, the race is fixed, secrets are excluded, and every test that
can run here passes. What remains is genuinely environmental: an Android build
and a Firestore emulator, neither of which exists in this sandbox.

---

## A. Git baseline

| | |
|---|---|
| Previous HEAD | `7049cc1a09388c3207b18bab270a871f8b6380f3` (20 June 2026) |
| Baseline commit | `d5d336545d14887b9c6f07d7a31e7f6aeadf0d63` |
| Phase-B fix commit | `c1bd2a7dfc1bbb4a616ffb908494ffb3910b27a3` (now HEAD) |
| Branch | `v5-scratch`, **5 commits ahead of `origin/v5-scratch`** — not pushed |
| Files **added** | **721** |
| Files **modified** | **34** |
| Files **deleted** | **1,974** (1,973 build artifacts + `local.properties`, all untracked-not-erased) |
| Files **renamed** | 4 (exact renames) |
| Total in baseline commit | **2,729 files**, +308,763 / −71,785 lines |
| Tracked files | **79 → 795** |
| Intentionally ignored | 39 top-level entries (`node_modules`, `.venv`, `lib/`, `build/`, `.gradle/`, `.next/`, `out/`, `.env*`, `local.properties`, service-account key, `.DS_Store`, `*.tsbuildinfo`) |
| **Secrets excluded** | **Yes — verified by path and by content** |

### Coverage now under version control

```
functions/src              23 / 23   (was 0)
firestore.rules                  ✓   (was untracked)
firestore.indexes.json           ✓
firebase.json, storage.rules, .firebaserc   ✓
backend/                   137 files (was 0) — source, 39 test modules, requirements, Dockerfile
zipper-crm/                174 files (was 0) — Next.js source and config
zipper-app/ Kotlin         167 / 167 (was 26)
docs/                      Phase 0 documentation + the Workstream 0 reports
```

### Final `git status`

```
?? functions/entry-lotties/
?? functions/entry-thumbnails/
?? functions/entry-video/
```

Nothing modified, nothing staged. The three untracked entries are deliberate —
see "Held back" below.

### Working-tree integrity, proved

A full checksum manifest was taken before any git operation and compared after:

```
files before : 11,233
files after  : 11,233
files lost   : 0
files changed: 7   (the 3 I edited + 4 regenerated functions/lib artifacts)
```

A snapshot is preserved at `outputs/git-baseline-snapshot/`: the manifest, the
complete pre-operation git state, the pre-operation `.git/index`, and an 11 MB
tar of the source tree.

### Held back — a decision for you, not for me

`functions/entry-lotties` (102 MB), `entry-video` (8.2 MB),
`entry-thumbnails` (904 KB) — **44 files, 111 MB** of entrance artwork.

These are **source assets, not generated**, so they are neither committed nor
ignored: they stay untracked and visible in `git status`. 111 MB in git history
is irreversible, and `firebase.json` already excludes them from function deploys
with a note that they are "inputs to the one-off upload scripts, not something
any function reads at runtime".

Options: Git LFS, a separate asset repository, or accept the history cost. No
single file exceeds GitHub's 100 MB hard limit, but the push would be ~111 MB.

### Two things the previous report got wrong, corrected

1. **"Not gitignored, never added" was only half right.** `.gitignore` is
   thorough and deliberate — it already names `local.properties`, the Agora
   certificate, service-account keys and `.env` files, with comments explaining
   each. The source directories were untracked; the secret protection was
   already correct.

2. **The index already held 1,969 staged deletions** — someone had already run
   `git rm --cached` over the committed build caches *and* `local.properties`.
   Those were preserved, not re-staged, and the baseline commit carries them.

### Why nothing had been committed since June

A stale, **empty `.git/HEAD.lock` dated 20 June 06:59** — the same morning as
the last commit. Every commit attempt since would have failed with
*"cannot lock ref 'HEAD'"*. It was removed (backed up to the snapshot folder)
after confirming no git process held it. This is likely the mechanical reason
for the gap, alongside the deliberate choice not to push.

---

## B. Commit

```
Commit SHA:     d5d336545d14887b9c6f07d7a31e7f6aeadf0d63
Commit message: chore: establish current ZIPPER development baseline

Commit SHA:     c1bd2a7dfc1bbb4a616ffb908494ffb3910b27a3
Commit message: fix(quick-login): make credential consumption atomic
```

The baseline message states explicitly that it is **not** "Phase B" — it carries
Phase 0 discovery, the Phase 1–3 security work, Workstream 0 Phases A and B, and
the CRM/backend/Android work that accrued alongside.

The Phase-B fixes are a **separate** commit, so the baseline stays reviewable as
a single capture and the fix stays reviewable as a single change. Committing them
rather than leaving them loose avoids recreating the problem just solved.

**Not pushed.** Awaiting your instruction.

---

## C. Phase-B fixes

### Atomic Quick Login rotation — fixed

**Before:** `credRef.get()` outside any transaction, then an unconditional
`credRef.delete()`. Two redemptions carrying **different** challenges both saw
the credential live, both verified, both completed — two custom tokens and one
orphaned 30-day credential.

**After:** consumption is a Firestore transaction whose contended resource is the
credential's existence. It re-reads the document; only the caller that observes
it present deletes it, writes the replacement and clears the rate record. Reads
precede writes, as Firestore requires.

The existing challenge transaction is untouched and does a different job: it
stops one *challenge* being spent twice; this stops one *credential* being spent
twice. Neither subsumes the other.

Every §17 requirement, verified behaviourally:

| Requirement | Result |
|---|---|
| Consumption is atomic | transaction on `credRef` |
| Two concurrent redemptions cannot both succeed | **exactly 1 winner** (also proven with 5 at once) |
| Exactly one consumes the credential | 1 |
| The loser fails cleanly | `aborted` / detail `concurrent` |
| Only one replacement remains | `quickLoginTokens` count = 1 |
| No orphaned 30-day credential | 0 orphans |
| Device-key/signature requirement preserved | a valid-vs-invalid race: the invalid one loses on *signature*, not on the race |
| Account-state behaviour preserved | a banned account racing itself is reported `banned` twice, mints nothing, keeps its credential |
| Audit behaviour preserved | one `QUICK_LOGIN_SUCCESS`, one `QUICK_LOGIN_RACE_LOST`, no secret in either |

**Why the loser is `aborted`/`concurrent` and not a refusal.** The detail code is
deliberately *not* a `QuickLoginOutcome`. The caller did nothing wrong, so
nothing counts against the rate limit; and `AuthRepository.refuseQuickLogin`
routes unknown detail codes to its `else` branch, which **keeps** the local
credential. A `refused` detail would have made the loser clear the replacement
the winner had just saved — turning a harmless race into a lost credential.
**This needed no Android change.**

The credential document shape is now built by a single `credentialDocument()`
helper, so the plain write and the transactional rotation cannot drift apart.

### Concurrency test — added

**12 new behavioural tests** driving the real handlers against an in-memory
Firestore. The previously-`todo` expectation now passes, and the test that
documented the defect is gone.

**Mutation-tested: 6/6 regressions caught** — reverting to the non-atomic
read/delete, dropping the lost-race check, not deleting the old credential,
reporting the loser as a refusal, not clearing the rate record, and losing the
inherited device key. (Two further mutations were rejected by `tsc`.)

### Config comment — corrected

`mobileSession.ts` described the flag as `ENFORCE_PRESENTED_SESSION`. Nothing
reads that name; the variable is `ENFORCE_MOBILE_SESSION`. Anyone setting the
documented name would have seen no behaviour change and reasonably concluded the
control was broken. The note now states the name once, explains the trap, and
points at the rollout sequence.

**The flag itself was not enabled.** Still unset in every environment.

---

## D. Android

> ## Android compilation: BLOCKED BY ENVIRONMENT

Re-attempted for real:

```
$ cd zipper-app && ./gradlew assembleDebug --offline --no-daemon --console=plain
Downloading https://services.gradle.org/distributions/gradle-8.14.5-bin.zip
Exception in thread "main" java.io.IOException: Unable to tunnel through proxy.
        Proxy returns "HTTP/1.1 403 Forbidden"
EXIT=1
```

`--offline` cannot help: the wrapper must fetch the distribution before any
Gradle flag is parsed.

| Requirement | Present | Evidence |
|---|---|---|
| JDK 17 | **No** | JDK 11.0.32 only; project declares `sourceCompatibility`/`jvmTarget` 17, AGP 8.5.2 requires 17 |
| Android SDK, `compileSdk 34` | **No** | `ANDROID_HOME`/`ANDROID_SDK_ROOT` unset, no `sdkmanager`, no `adb` |
| Gradle 8.14.5 | **No** | 0 complete distributions cached (only 0-byte `.part`/`.lck` remnants) |
| Network for AGP/dependencies | **No** | `services.gradle.org` → connection failure; npm/PyPI/dl.google.com all blocked |

No dependency cache (`~/.m2`, `~/.gradle/caches/modules-2` absent). No emulator,
no device, no `adb` — so the §4 on-device Quick Login scenarios remain unverified
too.

**No compilation claim is made. Symbol inspection is not compilation.**

### Required build environment

- JDK **17**
- Android SDK with **platform 34** + build-tools
- Gradle **8.14.5** (the wrapper fetches it given network)
- Network access to `services.gradle.org`, `dl.google.com`, `repo.maven.apache.org`
- The signing keystore + `local.properties` (machine-local, correctly not in git)
- For §4: an emulator or a physical device with `adb`

Your own machine already has the SDK at `~/Library/Android/sdk` per
`local.properties`, so a local `./gradlew assembleDebug` is the shortest path. A
CI runner (GitHub Actions `ubuntu-latest` + `actions/setup-java@v4` with JDK 17 +
`android-actions/setup-android`) would make this repeatable now that the source
is committed.

---

## E. Secrets

```
Agora App Certificate:        ROTATION REQUIRED
Release keystore credential:  REVIEW EXPOSURE STATUS
```

No values are printed in this report, were committed, or appear in any staged
diff.

**One escalation you need to know about.** `zipper-app/local.properties` was
committed in **`06f2afb`**, and that commit is **reachable from
`origin/v5-scratch`** — it is in the GitHub repository's history, not merely in a
local working tree. The exposure is therefore wider than a single inspection
session. Rotation is mandatory; whether to rewrite history is a separate
decision with its own costs.

A second, older exposure: a v4-era `.env` is present in `0491f23`, reachable from
both `origin/main` and `origin/archive/v4-production`.

Both are **operational security actions for the project owner.** I have not
rotated anything — no authorisation and no tooling to do so.

### What the baseline did about it

`local.properties` is now **untracked** (staged deletion carried by the baseline
commit), **ignored**, and **still on disk** so the build keeps working. It cannot
be re-committed by accident.

### Sensitive-file audit

| File | Status |
|---|---|
| `zipper-app/local.properties` | sensitive → **untracked + ignored + on disk** |
| `functions/.env` | sensitive → must remain ignored ✓ |
| `backend/.env` | sensitive → must remain ignored ✓ |
| `zipper-crm/.env.local` | sensitive → must remain ignored ✓ |
| `serviceAccountKey.json` | sensitive → must remain ignored ✓ |
| `backend/.env.example` | **template, committed** — every real secret empty; `JWT_SECRET=change-me` is the placeholder Phase A's startup gate rejects |

**Checked and found NOT sensitive** (so left as-is rather than disrupting builds):

- `zipper-app/app/google-services.json` — **tracked**, and it matches the
  sensitive-pattern list, so flagging it was required. Assessed: Firebase
  *client* config only — project id, app id, Android API key, OAuth client id,
  cert hash. **Zero private-key-shaped fields.** Firebase client keys ship inside
  every APK and are public by design. Left tracked; untracking would break
  builds. Your call if you disagree.
- `zipper-app/FINGERPRINTS.md` — password lines are `<placeholders>`; SHA
  fingerprints are public by design.
- `zipper-app/backup-signing-key.sh` — every password mention is prose in a
  comment; the executable lines read from the ignored `local.properties`.
- `zipper-app/app/build.gradle.kts` — `storePassword`/`keyPassword` are
  `localProperties.getProperty(...)` reads, not literals.
- `backend/app/services/verification.py` — `hasattr(creds, "private_key_id")`, a
  field-name check in code.
- 4 backend test files — `SG.test-key…` fixtures.

### One follow-up worth your attention

Two **Firebase Web** API keys are committed (CRM upload scripts,
`lottie-test.html`, `ZIPPERN_SETUP_GUIDE.md` as `NEXT_PUBLIC_FIREBASE_API_KEY`).
Public by design and already shipping in the CRM's browser bundle, so not a
commit blocker — but **verify they are restricted** (HTTP referrer + API
allowlist) in the Google Cloud console. An unrestricted Google API key can be
driven against other billable APIs.

Also: `backend/.env.example` contains two personal Gmail addresses as defaults.
Fine for a private repo; worth replacing with placeholders before the repo is
ever made public.

---

## F. Production configuration

| | |
|---|---|
| `ENFORCE_MOBILE_SESSION` current state | **Unset in every environment.** Not in `functions/.env`, not in `backend/.env`, not in `firebase.json`. Code default is `false`. |
| Would production enforce one active session today? | **No.** |
| Changed by this task? | **No.** Deliberately preserved. |

### Why it remains disabled

From the code's own note, and it is sound:

> Every build currently on the estate calls these functions without a session id,
> so turning this on before the app ships would sign out every user on the
> platform at once.

Enabling it before a client that sends `sessionId` is the minimum supported
version would be a platform-wide forced logout.

### Rollout sequence

```
1. Commit baseline                                    ← DONE (d5d3365, c1bd2a7)
2. Build Android Phase-B release                       ← blocked on build env (D)
3. Verify Android on a real device
4. Release / update supported clients
5. Establish minimum supported client version
6. Confirm sessionId is sent by supported clients
7. Enable ENFORCE_MOBILE_SESSION=true                  ← NOT done in this task
8. Monitor displacement / session errors
```

---

## G. Firebase

### Functions readiness

| Check | Result |
|---|---|
| Functions defined | 54 |
| Defined but not exported (would silently not deploy) | **0** |
| Duplicate names | **0** |
| Exports referencing a deleted function | **0** |
| Phase-B surface defined + exported + regioned | **9/9**, all `asia-south1` |
| Runtime | Node 22, `firebase-functions ^4.8.0`, `firebase-admin ^12.0.0`, v1 API |
| `predeploy` hook | `npm run build` — a source change cannot ship stale `lib/` |
| TypeScript / build | **clean** |

### Rules verification status

> **Unexecuted. No rule in this repo has ever been compiled.**

`firebase-tools` cannot be installed (npm registry returns 403) and no emulator
jar is vendored. The four Phase-B blocks are **text-verified only**, via
brace-balanced extraction:

```
quickLoginTokens      allow read, write: if false
quickLoginChallenges  allow read, write: if false
quickLoginRate        allow read, write: if false
authEvents            allow read: if isStaff();  allow write: if false
```

`firestore.rules` is now **tracked**, so it is reviewable for the first time.

### Appeals index status

| Check | Result |
|---|---|
| Declared in `firestore.indexes.json` | **Yes** — `subjectUid ASC`, `createdAt DESC` |
| Valid JSON | Yes, 43 indexes total |
| Tracked by git | **Yes** (was untracked) |
| Deployed | **Index declared but not deployed** — not verifiable here (no `firebase`/`gcloud` CLI, no credentials, `.firebaserc` etags empty) |

Command required eventually — **not executed**:

```bash
firebase deploy --only firestore:indexes --project zipper-83816
```

Index builds are additive and non-destructive.

### Staging

```
FOLLOW-UP INFRASTRUCTURE ITEM:
No dedicated staging Firebase project exists.
```

`.firebaserc` defines a single project, `zipper-83816`, serving everything. **No
project was created.**

---

## H. Tests

| Suite | Total | Pass | Fail | Skipped | Todo |
|---|---|---|---|---|---|
| Functions (`npm test` = `tsc && node --test`) | **425** | **425** | **0** | 0 | **0** |
| ↳ of which `quickLoginRuntime` (real handlers) | 69 | 69 | 0 | 0 | 0 |
| ↳ of which the new concurrency block | 12 | 12 | 0 | — | — |
| Backend (39 standalone modules) | **8,433 checks** | all | **0** | — | — |
| Functions `tsc --noEmit` | clean | | | | |
| Functions `npm run build` | clean | | | | |
| CRM `tsc --noEmit` | clean | | | | |
| Android compilation | **not run — blocked** | | | | |
| Firestore rules under emulator | **not run — blocked** | | | | |

Mutation testing, reported separately: **6/6** caught on the new atomic-rotation
fix; **36/36** on the earlier Phase-B + A5 work.

The previous `todo` is gone — the defect it marked is fixed.

---

## I. Remaining blockers

### Must fix before deployment

1. **Compile Android** (JDK 17 + SDK 34 + network) and run the §4 on-device Quick
   Login scenarios. ~2,900 lines of changed Kotlin have never been compiled, and
   Phase A already shipped one name-level compile error through this gap.
2. **Execute `firestore.rules` under the emulator.** They have never been
   compiled anywhere. Text assertions are standing in for the rules engine.
3. **Deploy the `appeals` composite index** before relying on appeal history.

### Operational actions required

4. **Agora App Certificate: ROTATION REQUIRED** — exposed in pushed git history
   (`06f2afb`, reachable from `origin/v5-scratch`).
5. **Release keystore credential: REVIEW EXPOSURE STATUS** — same commit.
6. **v4-era `.env` in pushed history** (`0491f23`, on `origin/main` and
   `origin/archive/v4-production`) — review and rotate anything still live.
7. **Verify the Firebase Web API keys are restricted** in Google Cloud.
8. **Decide on the 111 MB of entrance assets** — Git LFS, separate repo, or
   accept the history cost. They are untracked and intact.
9. **Decide whether to push.** 5 commits ahead of `origin/v5-scratch`; nothing
   pushed.

### Follow-up items

10. **No dedicated staging Firebase project exists.**
11. `ENFORCE_MOBILE_SESSION` rollout — step 7 of section F, after the Android
    release.
12. `notBanned()` in `firestore.rules` checks only `isBanned`, so a suspended
    account holding a live session passes `isActiveAppUser()`. Pre-existing
    moderation clause, out of scope here.
13. `DeviceSecretStore` (guest recovery) is still cloud-backed and its secret
    buys a full session with no signature. **Not modified**, per instruction — a
    product decision about whether guest accounts should survive a device
    transfer.
14. `AppealRepository.myAppeals()` needs the new index to have ever worked; it
    fails silently today inside `catch { emptyList() }`.
15. Replace the two personal email defaults in `backend/.env.example` with
    placeholders before the repo is ever public.

---

## Scope discipline

- No deploy, no migration, no production data read or written.
- No `git reset`, no `git clean`, no discarded work, no history rewrite.
- No Phase C. No authentication or business-logic redesign.
- `DeviceSecretStore` untouched.
- Ignore additions were two lines, generated files only: `*.tsbuildinfo` and
  `.DS_Store`. **No source directory is ignored.**
- Working tree proved intact: 11,233 files before and after, 0 lost.

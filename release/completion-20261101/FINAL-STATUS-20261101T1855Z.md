# ZIPPER — consolidated status, safe cleanup and completion review

1 Nov 2026, 18:55 UTC (2 Nov, 00:25 IST).

This was a read-only review plus small local fixes. Nothing was deployed, published, pushed, reset or rotated. Production is unchanged since 30 Oct: the Mac preflight passed at 17:17 UTC.

## 1. Repository and work protection

| Item | State |
|---|---|
| Branch and HEAD before this review | `v5-scratch` @ `a3d9c767ad22` |
| This review | One local commit on top of it: the commit that adds this file (`git log -1 -- release/completion-20261101/FINAL-STATUS-20261101T1855Z.md`) |
| Rollback base | Branch `prod-live-20261030` = `4e21b7f14f7c`, byte-identical to production; tag `prod-live-20261030-tag` |
| Pushed | No (D5). Every commit exists only on this Mac. |
| Untracked and kept | `hotfix/rules-20261101/results-20261101T173556Z/` and `tests/results-rc2-20261101T173700Z/`: LOCAL-VERIFY evidence, which the release scripts tolerate |
| Running processes | None in my workspace. LOCAL-VERIFY `20261101T173305Z` finished at 17:56:58 UTC. Nothing was interrupted. |
| Evidence | Untouched: `local-verify-20261101T173305Z/`, `production/` (make-release-txt and 00-preflight), `~/zipper-release/**` |

### What changed in this session

**Production:** nothing.

**Local commits `00af9aa` → `a3d9c76` (20):** the specification implemented across the backend, Functions, rules, CRM, Android and reset tooling, plus the guarded release scripts. They are listed in `~/zipper-release/system-audit-20261101/COMPLETION-STATUS-2026-11-01.md` §2.

**This review (one commit):**

| File | Change | For |
|---|---|---|
| `backend/tests/test_security_phase1.py` | Parses the new `appConfig` rule form | 3b |
| `zipper-crm/lib/auth.ts` | One comment line no longer contains a Gmail address | 4e |
| `zipper-app/app/src/test/.../WorkParityTest.kt` | `;` removed from one test name | 6a |
| `LOCAL-VERIFY-mac.command` | 6a counts only this run's test XML and requires `testDebugUnitTest` to execute. 6b uses `apk_cert.py` and the pinned certificate. | 6a, 6b |
| `tools/apk_cert.py` (new) | Reads the APK Signing Block and prints the scheme, certificate count, SHA-256 and CN | 6b |
| `rel_common.sh` | Pins `FLEET_CERT_SHA256` | 6b, step 7 |
| `60-publish-apk.command`, `rel_helpers.py` | Refuse an APK that is not signed with the pinned fleet certificate | Step 7 |
| `tools/test_release_scripts.py`, `tools/write-scripts-sha256.command`, `SCRIPTS.sha256` | New harness cases; `apk_cert.py` added to the guarded list (33 files) | — |
| `LOCAL-VERIFY-README.md`, `RUNBOOK.md` | Document the changes above | — |
| `.gitignore` | Ignores the p1mfa runner's `*.log.summary`, which would otherwise dirty the tree and block every release script | — |
| `tools/cleanup-build-outputs.command` (new) | Disk cleanup that you run yourself (section 4) | — |
| This file (new) | — | — |

## 2. The four failed checks of LOCAL-VERIFY 20261101T173305Z

### 3b — backend `test_security_phase1`

- **Failure:** `IndexError: list index out of range` at line 188 of the test (`app_config.split("allow write:")[1]`). The other 105 modules passed: 15,412 checks, 0 failed.
- **Root cause:** a defect in the test, not in the product. Commit `2d5f29a` (lucky gifts ship off) replaced the single `allow write:` arm of the `appConfig` rule with create, update and delete arms that all go through one helper, `appConfigWriter()`. The test only understood the old form.
- **Change:** the test reads both forms. It now also asserts that every write arm goes through `appConfigWriter()` and that `androidUpdate` is never writable from a client.
- **Verified:** in the sandbox at 18:5x UTC, `All 121 phase-1 security checks passed`, exit 0. The full sandbox suite after the fix: 105 of 106 modules. `test_sendgrid_sdk_http` exits 2 here by design because the sandbox has no SendGrid SDK; it passed on the Mac.
- **Not verified:** the Mac run.
- **Rerun:** `bash LOCAL-VERIFY-mac.command`. Expect 3b `modules 106: 106 exit 0`.
- **Residual risk:** low. The test is a static check of the rules text, and both machines read the same file.

### 4e — CRM `verify:out`

- **Failure:** 1 of 89 checks, `no @gmail.com literal reaches the auth module`. Steps 4a–4d passed: typecheck 0 errors; 30 specs with 10,454 checks; `next build` 95/95 pages.
- **Root cause:** a comment at `lib/auth.ts:591` contained a Gmail address. The guard bans that literal anywhere in the auth module, so the Observer mailbox lives only in `NEXT_PUBLIC_OBSERVER_EMAIL`.
- **Change:** the comment now says "the Observer's address". One line; no code change.
- **Verified:**
  - Both auth guards from `scripts/verify-out.mjs` pass against the fixed file; HEAD `a3d9c76` had 1 match.
  - The CRM typecheck is clean.
- **Not verified:** the whole of `verify:out`. It also requires `out/` to be newer than the sources, so it needs a fresh `next build`, which runs only on the Mac.
- **Separate finding (4d note):** `zipper-crm/.env.local` has no `NEXT_PUBLIC_OBSERVER_EMAIL`, and `deploy-crm.command` refuses to run without it. You add it; I never open `.env` files.
- **Rerun:** the same LOCAL-VERIFY run. Expect 4d and 4e PASS, and no 4d note.
- **Residual risk:** low.

### 6a — Android `testDebugUnitTest`

- **Failure:** `:app:compileDebugUnitTestKotlin FAILED` with `WorkParityTest.kt:290:15 Name contains illegal characters: ;`, so no unit test ran. The summary still said "unit tests 310, failures 0". That count came from 34 stale XML files of a 25 Oct run and is false.
- **Root cause:**
  1. `;` is illegal in a JVM method name, and a backticked Kotlin test name becomes a method name.
  2. The launcher did not check that the XML came from the current run.
- **Change:**
  1. The `;` is removed from the test name.
  2. 6a now writes a start marker and counts only XML newer than it, unless Gradle reports the task UP-TO-DATE or FROM-CACHE. It fails unless `testDebugUnitTest` executed with at least 1 test, 0 failures and 0 errors.
- **Verified:**
  - The compiler reported exactly 1 error in that run, so no other front-end error is waiting.
  - A scan of all 417 backticked function names in `src/test` and `src/main` finds no other JVM-illegal character.
  - `bash -n` passes on the launcher.
- **Not verified:** no Android unit test has run at this HEAD. Ten test classes have never run at all:
  - `OwnerMfaGateTest`, `WorkParityTest`, `HostSuspensionActionsTest`
  - `CallBillingTest`, `LuckyCombosTest`, `LevelVisibilityTest`
  - `SessionCutoffTest`, `ProfilePhotoUploadTest`, `Apk20WiringTest`, `ApkVerificationTest`

  The rest last ran on 25 Oct, against older code.
- **Rerun:** the same LOCAL-VERIFY run. Expect 6a to report `testDebugUnitTest executed` with failures 0 and errors 0.
- **Residual risk:** medium. These tests cover the Owner TOTP gate, Work-hub parity, the per-minute billing UI and lucky combos. Any failure there is a real defect, to be fixed before step 7.

### 6b — prod APK signer check

- **Failure:** both prod APKs failed with `signer certificates: 0`, CN `?` and SHA-256 `?`. Yet `apksigner verify` exited 0 (the signature is valid), versionCode was 20 and the APKs were not debuggable.
- **Root cause:** the launcher's parser of the `apksigner --print-certs` text found nothing in the build-tools 37.0.0 output. The raw text was not kept, so the exact mismatch is unknown. The APKs were fine.
- **Change:**
  - `tools/apk_cert.py` reads the v2 APK Signing Block directly.
  - 6b and `60-publish-apk.command` compare the certificate with the pinned fleet certificate, `FLEET_CERT_SHA256 = 4878a35f…1948af` (the certificate of the installed APK 19).
  - The raw `apksigner` output is now saved as evidence.
- **Verified:**
  - In the sandbox, on your files: `app-arm64-v8a-prod.apk` and `app-armeabi-v7a-prod.apk` from that run, and APK 19, all show scheme v2, 1 certificate, SHA-256 `4878a35f…1948af` and CN `Android Debug`. APK 20 therefore installs over APK 19.
  - `SCRIPTS.sha256` 33/33 OK; release harness 277/277.
- **Not verified:**
  - The new 6b path on the Mac.
  - The release harness under the Mac's bash 3.2: `tools/test-release-scripts-mac.command` has never run.
- **Rerun:** the same LOCAL-VERIFY run (expect 6b `2 of 2 prod APK(s) pass`), plus `bash tools/test-release-scripts-mac.command`.
- **Residual risk:** low. The prod APKs are rebuilt at the final HEAD in step 7 anyway.

## 3. Module status

No module is deployed yet. Production runs the 20 Oct release plus the 30 Oct email change.

| Module | Status | Evidence | Open |
|---|---|---|---|
| Backend API | PRODUCTION DEPLOYMENT PENDING, after the 3b rerun | Mac 3b: 105/106 modules, 15,412 checks, 0 failed checks; the fixed module passes 121/121 in the sandbox | Steps 3–4 |
| Auth, identity, sessions | IMPLEMENTED BUT NOT VERIFIED end to end | Backend session rules (B3); Functions `startMobileSession` tests in 1814/1814 (Mac) | The sign-in-method identity matrix needs the clean database and devices, after step 12 |
| Owner / Observer MFA | IMPLEMENTED BUT NOT VERIFIED (Android gate) | `test_observer_mfa` 123 and the MFA suites; rules p1mfa 1,067/0 and RC2 1,645/0 (Mac) | 6a (`OwnerMfaGateTest`); steps 4, 6, 9 and 9b (after all Owners enrol) |
| Roles and eligibility | PRODUCTION DEPLOYMENT PENDING; two rules BLOCKED BY MY DECISION | `test_b2_governance` 266, `test_host_role_suspension` 97, Functions host gates 37 | C4, C5 |
| CRM and permissions | IMPLEMENTED BUT NOT VERIFIED (`verify:out`) | Mac 4a–4d PASS; 4e fixed, needs a rebuild | `.env.local` value (R1); rerun; step 6 |
| Ledger and reconciliation | PRODUCTION DEPLOYMENT PENDING | Functions 1814/1814 (Mac); backend `test_m_*` 319 | Steps 5 and 8; checked in production by step 11 |
| Gifts, calls, diamonds, beans, payouts | PRODUCTION DEPLOYMENT PENDING (server); Android UI NOT VERIFIED | Functions 1814/1814, including per-minute billing; `CallBillingTest` has never run | 6a; wave 2b only after the fleet runs APK 20; B1, B4, B5, B7 |
| Lucky gifts | BLOCKED BY MY DECISION (A2: off until legal clearance) | The server refuses with `LUCKY_GIFTS_DISABLED`; Owner-only switch `appConfig/luckyGifts.enabled`, default off | Legal clearance; O3; gap 15 |
| Moderation (warn, suspend, ban, appeal) | PRODUCTION DEPLOYMENT PENDING | Backend governance suites; CRM screens `c119f84` (in 4c and 4d) | C7, C9, C10 |
| Agency, sub-agency, host, coin seller | PRODUCTION DEPLOYMENT PENDING; transfer settlement BLOCKED BY MY DECISION | Backend suites; `OWNER_DECISION_PENDING` in `zipper-crm/lib/governanceRequests.ts` | B7, C5 |
| Email / SendGrid | PARTIALLY COMPLETE | The 8 email Functions have run on SendGrid since 30 Oct with 0 verified sends; the backend has not yet been granted the key; `test_email_identities` 378 | Phase 3, step 3, R3 |
| Firestore and Storage rules | Verified locally on the emulators; PRODUCTION DEPLOYMENT PENDING | Mac: 5a hotfix-1 PASS, 5b RC2 1,645/0, 5c 1,067/0, 5d 505/0 | Step 2 (fixes the profile-setup "permission denied"); step 9 |
| Firestore indexes | PRODUCTION DEPLOYMENT PENDING | `33-deploy-indexes` refuses unless the file is a superset of the live indexes | Step 2 |
| Android app and APK 20 signing | IMPLEMENTED BUT NOT VERIFIED | Debug and prod builds succeed on the Mac; versionCode 20; fleet certificate confirmed | 6a/6b rerun; rebuild at the final HEAD; device smoke; step 7 |
| Deploy scripts and rollback | Verified in the sandbox (bash 5.1); NOT VERIFIED on the Mac's bash 3.2 | Harness 277/277; `SCRIPTS.sha256` 33 OK; Mac preflight PASS; rollback base = production | `test-release-scripts-mac.command` |
| Reset and backup | IMPLEMENTED BUT NOT VERIFIED (never executed); BLOCKED BY MY DECISION | `test_reset_tooling` 244/244 | A1, E2, E3; after acceptance |
| Credential rotation | NOT STARTED, by design (final phase) | Rotation scripts harness 90/90 | After acceptance; D6 |
| Monitoring and post-deploy verify | IMPLEMENTED BUT NOT VERIFIED | Scripts 70 and 90 | Steps 10 and 11, then again after 24 h |
| One-device enforcement | BLOCKED BY MY DECISION (D3); the staff-token exception is NOT STARTED | `functions/src/mobileSession.ts`: the flag defaults to off; turning it on would break CRM live-watch | After the release |

## 4. Disk space

**Mac volume:** 229 GB, 9.3 GB free (96 % used) at 18:46 UTC.

**Recovered by me: 0 bytes.** I do not delete files on your Mac. The script below does it after you type a word.

**The script:** `release/completion-20261101/tools/cleanup-build-outputs.command`.
- It refuses to run while any of these is active: a Gradle or Kotlin daemon, `next build` or `next dev`, an emulator run, or LOCAL-VERIFY.
- It lists each path and its size, and deletes only after you type `CLEAN`. The preview cache also needs `PREVIEW`.
- It logs to `production/cleanup-<UTC>.txt`, which git ignores.
- I tested it here on a mock tree. It refused while a daemon was running and when `CLEAN` was not typed. It removed exactly the listed folders and kept `outputs/`, `test-results/`, `out/` and the preview's `firebase.json`.

| Path | Size | Why it is safe | Removed after |
|---|---|---|---|
| `zipper-app/app/build/intermediates` | 1.4 GB | Gradle intermediates; the next build recreates them and is slower | `CLEAN` |
| `zipper-app/app/build/tmp` | 45 MB | Gradle temporary files | `CLEAN` |
| `zipper-crm/.next` | 408 MB | Next.js build cache; `npm run build` recreates it; `out/` stays | `CLEAN` |
| `~/zipper-release/mfa-crm-preview-20261029T203711Z/zipper-crm/.next` | 393 MB | Build cache inside the 29 Oct preview folder, which was never deployed; the folder's config and log stay | `PREVIEW` (question O1) |

**Kept on purpose:**
- `app/build/outputs`, 403 MB: the current APKs.
- `zipper-app/build/published`, 505 MB: APKs 13, 14 and 19, the patch base and the rollback reference.
- Every `node_modules` (CRM 559 MB, functions 160 MB, tests 142 MB), `backend/.venv` (249 MB) and `.git` (448 MB).
- The `~/zipper-release` evidence. Its stage1-deploy virtualenv (263 MB) is used by the sandbox runner.

**Expected result:** about 1.85 GB back, or 2.24 GB with `PREVIEW`. About 1.4 GB of that comes back with the next Android build, so lasting space has to come from outside the project. The script prints the sizes of these folders, read-only, with the commands to clear the first two:
- `~/.gradle/caches` and `~/.npm/_cacache`
- `~/Library/Caches/Google` and `~/Library/Caches/pip`
- `~/.android/avd` and Xcode `DerivedData`

I cannot see those folders.

## 5. Gaps, prioritised

**P0: blocks the first production step**
1. [verification] Rerun 3b, 4e, 6a, 6b and the bash-3.2 harness on the Mac, at the new HEAD.
2. [your action] Add `NEXT_PUBLIC_OBSERVER_EMAIL` to `zipper-crm/.env.local` (see question R1).
3. [deployment] Run `./make-release-txt.sh` at the new HEAD; `RELEASE.txt` must match HEAD.
4. [deployment] Phase 3: one controlled SendGrid email, then `sg-C3-verify-readonly.command`. There have been 0 verified sends so far.

**P1: inside this release, before acceptance**

5. [deployment] Runbook steps 2–11, in order. Step 2 ships the escalation fix (profile setup "permission denied"). It is not live yet.
6. [missing tests] A failure in any of the ten never-run Android test classes becomes a P0 code defect before step 7.
7. [deployment] Smoke-test APK 20 on a device before step 7. Run wave 2b (step 8) only after the fleet runs APK 20.
8. [deployment] Do steps 4 and 6 on the same day: between them the Observer cannot use the old CRM. Every Owner binds TOTP before step 9b.
9. [risk] All commits exist only on this Mac (no push, D5). Make an offline copy, for example `git bundle create /Volumes/<drive>/zipper-v5-scratch.bundle --all`.
10. [risk] The prod APK is signed with the Mac's debug signing configuration (`zipper-app/app/build.gradle.kts` line 341, A-4; Android keeps that key in `~/.android/debug.keystore` by default). If that file is lost, no future APK can update the installed fleet. Confirm an offline backup (question S1).

**P2: after deployment, before or at acceptance**

11. [code] The staff-token exception for one-device enforcement (D3) is not implemented. The flag stays off.
12. [code] The CRM salary approval does not record the approver (`approvedBy`): the live rules refuse the field, and RC2 allows it. This is a small CRM change after step 9. The `host_withdrawal` card already names who raised and who signed the payout.
13. [code] Functions still writes `payout_approved` notices directly (`functions/src/index.ts:2059`), outside the single idempotent notice writer. A retried trigger could notify twice.
14. [missing tests] The identity matrix across sign-in methods, and the reset on real data, can only run after step 12.
15. [security] The old Cloud Run tags `rc-1-2-3` (→00042) and `rc-ugp` (→00044) still give old backend revisions their own URLs (question S2).

**P3: low risk or cleanup**

16. [code] The old CRM "lucky_gifts" toggle in Tech → App control (`zipper-crm/app/tech/appcontrol/page.tsx:38`) controls nothing, which is misleading next to A2. Remove it (the F2 default).
17. [code] `getPayoutStatus.nextReleaseAt` ignores the arrears setting. It is only wrong if B1 = 1.
18. [code] The quick-ban buttons on `/live` and `/hosts` send no category or evidence (C9).

## 6. Questionnaire: open questions only

**Already answered, not asked again:**
- A2: lucky gifts stay off until legal clearance.
- D3: one-device enforcement stays off until the staff exception exists.
- D5: no push until privacy is confirmed.
- Owner-alone money cards, with the other Owners notified.
- Per-minute billing.
- The lucky combo rules.
- The reset includes Owner and Observer identities, after a backup.
- Reset and rotation happen only after acceptance.

**How to answer:** "ID yes" accepts the recommended default; otherwise write your choice. If a question is unanswered, the code keeps what it does today.

### Critical release

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| R1 | Which address does the Observer sign in with? Is it your own Gmail account? You put it into `zipper-crm/.env.local` as `NEXT_PUBLIC_OBSERVER_EMAIL`. | The CRM build and deploy refuse without it; the Observer login uses it | None; I cannot choose it | Step 6 |
| R2 | (D5) Is the GitHub repository private? If yes, may I prepare the push command for you to run? | Off-machine copy of the work | No push; make an offline bundle instead | Nothing |
| R3 | (A3) Do info@ and support@zipperlive.org receive mail, and are they mailboxes, aliases or forwards? | Sender identities. Partner emails still name a personal Gmail as the help contact until this is answered. | Send only from no-reply@, with no Reply-To | Nothing |

### Financial and payout

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| B1 | Release earnings 0 or 1 week in arrears? With 1, earnings from 3–9 Nov are released on 17 Nov instead of 10 Nov. | Host cash flow; two settings change together | 0 (today) | Nothing |
| B4 | Is a manual CRM bean credit convert-only, withdrawable at once, or released next Monday? | Whether staff credits become cash | Convert-only (today) | Nothing |
| B5 | Hosts without an agency have no payout path. Is that intended? | Unpaid hosts | Yes | Nothing |
| B7 | At an agency transfer, who gets the commission for the host's unreleased (held) week? | Money attribution | Days before the move go to the old agency; the week is held until an Owner or Finance releases it | Nothing; held items wait |
| B8 | Host role suspension freezes the host's money, and resuming does not release it. Keep? | Host funds | Keep | Nothing |
| B9 | Should daily rewards require a verified phone or email? | Reward farming through guest phones | Off (today) | Nothing |
| B11 | Who may verify money cards? Today: Finance, plus department Admins for their own team. The spec says Finance only. | Strength of the four-eyes check | Finance only, as in the spec (small backend change) | Nothing |

### Roles, permissions and moderation

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| C4 | Can a person's only role be revoked? The older rule says no: suspend the account instead. The spec says revocation removes one capability. | Keeps moderation and role dimensions separate | The spec: revoke the role, and the account stays as a plain user | Nothing |
| C5 | Can hosts be transferred to a live sub-agency (today), or only to a main agency (spec)? | Transfer flow | Keep sub-agency targets, which are real rosters under a main agency | Nothing |
| C7 | Should a suspended host stay listed in the feed (callers hear "not taking calls"), be hidden, or show a badge? | User experience | Listed (today) | Nothing |
| C9 | Should the quick-ban buttons require a category and evidence? | Audit quality against speed | No (today) | Nothing |

### Reset and data retention

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| A1 | Seed list: for the Observer and each Owner, name, sign-in email and phone (+91…) | The reset recreates exactly these | None; I will not invent them | Step 12 |
| E2 | Storage folders the spec does not list: `sellerDocs`, `appealEvidence`, `coinPurchaseProofs`, `rechargeProofs`, `rechargeScreenshots`, `payoutScreenshots`, `evidence`, `feedbackAttachments`, `roomThumbs`, `hostPhotos`, `crmProfilePhotos` and the legacy folders. Delete them at the reset? | The reset refuses until each is decided | Delete all; they hold uploads of deleted accounts | Step 12 |
| C10 | Face-verification images at account purge: delete them, or keep them N days for disputes? | Privacy against disputes | Delete | Nothing |

### Security and credential rotation

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| S1 | Is the APK signing key (debug signing configuration, certificate `4878a35f…`) backed up off this Mac? | If it is lost, the fleet can never be updated again | Back it up now. You do this; I never open key files. | Nothing (P1) |
| S2 | After acceptance, remove the Cloud Run tags `rc-1-2-3` and `rc-ugp` (old revisions 00042 and 00044)? | Removes stale backend URLs. This is a production change and needs its own approval. | Yes, after acceptance; keep `rc-1-2-5` until the next release is accepted | Nothing |
| D6 | Should the rotation include the Firebase Admin key file on the Mac (`serviceAccountKey.json`)? | Completeness of the rotation | Yes | Step 13 |

### Operational and business

| ID | Question | Impact | Recommended default | Blocks |
|---|---|---|---|---|
| O1 | Delete the 393 MB `.next` cache inside the 29 Oct preview folder (section 4)? | Disk space | Yes; cache only, the config and log stay | Nothing |
| O3 | Lucky odds table for when lucky gifts are switched on: 5× 84 %, 10× 10 %, 25× 4 %, 50× 1.5 %, 100× 0.5 %. The expected reward is 7.45× one unit. | Payout cost of lucky gifts | That table | Only switching lucky gifts on, which also needs legal clearance (A2) |

## 7. Shortest completion plan

1. **You, 2 minutes:** add `NEXT_PUBLIC_OBSERVER_EMAIL=<Observer address>` to `zipper-crm/.env.local`. Optionally run the cleanup script.
2. **You, about 30 minutes unattended:** in `release/completion-20261101`, run `bash tools/test-release-scripts-mac.command`, then `bash LOCAL-VERIFY-mac.command` (the full run took 24 minutes last time). I read the evidence directly from your folder.
3. **You and me, about 15 minutes:** Phase 3, the controlled SendGrid email and `sg-C3-verify-readonly.command`.
4. **You:** `./make-release-txt.sh`, then `./00-preflight-readonly.command` (step 1).
5. **Steps 2 → 11, including 9b:** one approval each. I check each evidence folder before the next step. Step 2 ships the escalation fix.
6. **Phase 6:** acceptance, then `90-postdeploy-verify-readonly.command 1440` after 24 hours.
7. **Phase 7, after your acceptance:**
   - The reset, which needs A1, E2, the E3 mongosh canary and a verified backup.
   - Then the credential rotation (D6).

## 8. Release readiness

**Not ready for step 2 yet.** The release is ready once P0 items 1–4 pass. No known code defect blocks the release; the P2 and P3 code items can follow it.

## 9. What I could not verify

- Anything that needs your Mac's toolchain: Gradle and the Android SDK, `next build` (SWC), Python 3.12 with the real dependencies, bash 3.2 and the emulators. These run only through LOCAL-VERIFY.
- Processes on your Mac outside my workspace. The cleanup script checks them itself.
- Cache sizes outside the project.
- Production behaviour after each step, SendGrid delivery, APK 20 on devices, the identity matrix and the reset on real data.
- Whether the repository and the signing key have off-machine copies, and whether the GitHub repository is private.
- The exact `apksigner` text that the old 6b parser missed; it was not kept.

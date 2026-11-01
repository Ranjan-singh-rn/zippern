# ZIPPER Owner MFA — final verification and deployment gates

25 Oct 2026 · branch `v5-scratch`

**Bottom line: NOT DEPLOYED.** Three gates fail (§5). There was no production deployment, no production write and no production read. There was no `git commit`, `push`, `reset`, `clean`, stash or revert.

Evidence labels:
- **[RAN]**: I executed it in the sandbox and saw the output.
- **[YOU]**: your run on the Mac; I read the log or JUnit files where noted.
- **[NOT RUN]**: not run by anyone yet.

## 1. Files changed in this final phase

| File | Change | By |
|---|---|---|
| `tests/run-phase1a-validation.sh` | `zipper-83816` → `demo-zipper` (3 lines) | you (`sed`) |
| `tests/run-phase1a-validation.sh.bak` | backup of the above | you |
| `tests/run-phase1a-validation.sh` | `rules-storage` step now runs `--only storage,firestore`. It was `storage` only, which would fail now that `storage.rules` reads Firestore and the suite seeds it | me |
| `tests/firestore.p1mfa.rules.test.mjs` | +4 checks: a pending Owner keeps personal app access (own `users/{uid}` read, announcements read), cannot list users; a bound Owner can | me |

**Other checks:**
- Pre-change copies are in `outputs/p1-exec/before/`.
- `.firebaserc` is unchanged (`git diff` empty) [RAN].
- The 482 other modified or untracked paths are untouched.

## 2. Test-safety cleanup

| Check | Result |
|---|---|
| `bash -n tests/run-phase1a-validation.sh` | [RAN] passes |
| `grep -n zipper-83816 tests/run-phase1a-validation.sh` | [RAN] no match. Across `tests/`, only your `.bak` copy still contains it |
| Full-script review | [RAN] Only `firebase emulators:exec --project demo-zipper` under `env -u GOOGLE_APPLICATION_CREDENTIALS`, plus `./gradlew` (offline flags). No deploy, gcloud, curl, git or network |
| Harness endpoints | [RAN] every rules test pins `127.0.0.1`; every `projectId` is `demo-zipper` |
| `git diff --check` (whole tracked tree) | [RAN] **exit 2**: one hit, `backend/app/services/users.py:4634` "new blank line at EOF". That file is **unrelated pre-existing work** (2,048-line diff; never touched by me), so I left it. On every file I changed, `git diff --check` exits 0, with no trailing whitespace and final newlines present |

## 3. Verification results

| Suite | Command | Result |
|---|---|---|
| Backend, all modules | `python3 -m tests.<module>` ×87 | [RAN] **87/87**, all exit 0 |
| └ Owner MFA / binding / session lifetime / staff revocation | | [RAN] 68/68 · 46/46 · 247/247 · 81/81 |
| └ partner sessions / permissions / money permissions | | [RAN] 542/542 · 250/250 · 270/270 |
| └ tickets / directory privacy / survey read-only | | [RAN] 46/46 · 16/16 · pass |
| Functions | `tsc` + `node --test test/*.test.js`, fresh build in a full-repo mirror (`functions/lib` untouched) | [RAN] tsc exit 0; **1516/1516**, exit 0 (includes 13 `ownerMfa`) |
| CRM | `npx tsc --noEmit` | [RAN] exit 0, no output |
| Rules: storage, p1mfa:storage, firestore, phase1a, ugp, p1gov, p1mfa, fx, gov, rc | `tests/run-p1mfa-verify.command` | [YOU] 24 Oct 13:14, all exit 0. Results below. The rules sha256 in that log (`414c40…`) **equals the current `firestore.rules`**; `storage.rules` is unchanged since before the run |
| Android unit + build | `zipper-app/work-verify.command` | [YOU] 24 Oct 13:14: `testDebugUnitTest` and `assembleDebug` executed after my Android edits (04:18). JUnit XML: **307 tests, 0 failures, 0 errors**; the Owner MFA test is present and passed. The 25 Oct 02:17 run was `UP-TO-DATE` (cached) |
| `run-phase1a-validation.sh` (repaired) | | **[NOT RUN]** Script verified emulator-safe. Run it on your Mac |
| The 4 new p1mfa checks | | **[NOT RUN]** Rerun `tests/run-p1mfa-verify.command` |

**Rules results from your 24 Oct 13:14 run** (all exit 0):

| Suite | Checks passed |
|---|---|
| storage | 136 |
| p1mfa:storage | 35 |
| firestore | 114 |
| phase1a | 255 |
| ugp | 22 |
| p1gov | 95 |
| p1mfa | 115 |
| fx | 60 |
| gov | 74 |
| rc | 58 |

## 4. Existing user flows: evidence

| Flow | Evidence | Gap / recommended smoke test |
|---|---|---|
| App-user registration and login | firestore (114) and phase1a (255) rules suites; Functions account-lifecycle, quick-login and guest-binding tests (in 1516) | No end-to-end run. Smoke: register and sign in a new app user in the emulator app build |
| Personal profile and normal app use (incl. a pending Owner's personal use) | rules suites; +4 new p1mfa checks [NOT RUN] | Rerun p1mfa |
| Host login, verification, features | phase1a host rules, storage `hostVerification`, Functions host tests | Device smoke: host goes live |
| Agency / sub-agency / coin seller | p1gov, fx, gov, rc, storage; backend `test_partner_session` 542 | — |
| Department Admin/Member, all six departments | p1mfa "department roles unchanged" checks; p1gov; backend `test_permissions` 250 | — |
| Owner MFA enrolment, verify, retry unlock | backend 68 + 46; CRM type-check | **The CRM UI was never exercised.** Smoke: enrol, verify, retry unlock in a local CRM against the emulators |
| Android Owner workflows | 307 unit tests (token injection pinned) | **No device run** |
| Logout, renewal, re-login | `test_session_lifetime` 247; binding renewal and sign-out tests | — |
| Observer MFA reset | binding test (clears all, revokes sessions) | — |
| Owner suspend / deactivate / reactivate | `test_staff_revocation` 81 (functional binding checks) | Role change of an Owner is refused by the service; its binding clear is checked in source only |
| Pending Owner cannot bypass via `crmRole()`, `hasPerm()`, Storage, functions | p1mfa 115, p1mfa:storage 35, Functions `ownerMfa` 13 | `hasPerm`'s own gate is reachable only through `canDecideCoinOps`, which is tested |

## 5. Deployment gates

| Gate | Status |
|---|---|
| Final code and artifacts reviewed | ✔ for the MFA changes |
| Required automated tests pass | ✔ except the two [NOT RUN] items in §3 |
| User-flow regressions checked | Partially. UI and device smoke tests are missing (§4) |
| No production project ID in local runners | ✔ |
| Deploy targets and commands verified | ✔ read: `deploy.sh`, `deploy-crm.command` |
| Backend/CRM/Android/Functions/rules compatible | ✔ Old clients get `missing_token` (locked, safe). The order is mandatory: rules last |
| **No unrelated changes in the release** | ✘ **FAILS** (B1) |
| **Same-second same-provider sign-in cannot gain privileges** | ✘ **FAILS** (B2) |
| Cross-service IAM grant reviewed | ✘ not reviewable without the production project (B3) |
| Rollback feasible | ⚠ (§7) |

**B1 — the release cannot be isolated.** Every mechanism deploys from the working tree:
- `deploy.sh` runs `gcloud run deploy --source .` from `backend/`, `firebase deploy --only functions` (building all of `functions/src`), `firestore:rules`, `firestore:indexes` and `storage`;
- `deploy-crm.command` runs `npm run build` for the whole CRM, then rules plus hosting.

What each target would carry [RAN]:

| Target | Would also ship |
|---|---|
| `firestore.rules` | **1,412 changed lines that predate all Phase 1 work** |
| `storage.rules` | 648 lines that predate the MFA stage |
| Backend | 56 modified + 92 untracked files |
| Functions | 39 + 54 |
| CRM | 64 + 56 |
| Android | 53 + 56 |

Isolating only the reviewed changes would need a commit or branch (prohibited), or deploying unreviewed work (prohibited). **Stopped.**

**B2 — a design requirement is not met.** Bindings are independent per API session, sign-out of one never revokes another, and renewal never re-creates a removed binding (all tested). But rules can see only `auth_time` + provider. A second sign-in of the same account in the **same second with the same provider** is indistinguishable, and would gain authority without MFA. This was documented as a residual and is now an explicit requirement.

The proposed fix needs approval, because it is a material design change:
- After MFA, the backend mints a Firebase **custom token** carrying a per-session claim `mfa_sid = <bindingId>`.
- The client signs in with it. Developer claims persist across ID-token refreshes for that session only.
- The rules then require `bindings[mfa_sid]` to exist and be unexpired. That is unique per session, with no collision at all.
- **Implications:**
  - Cloud Run needs `iam.serviceAccounts.signBlob` (Service Account Token Creator on its own account);
  - the CRM's Firebase session is replaced at MFA;
  - Android must use a **secondary FirebaseApp** for Owner work. Replacing the app's own phone sign-in would break personal-app rules that read `phone_number` and the `sessionCurrent()` `auth_time` check.

**B3 — I cannot deploy, and the IAM grant cannot be reviewed from here.**
- The sandbox has no Firebase CLI, gcloud or credentials.
- `deploy.sh`, `deploy-crm.command` and `setup-email-and-deploy.command` are on the standing do-not-run list.
- Terminal is click-only for me.
- The Storage → Firestore cross-service prompt grants the Storage service agent read access to Firestore; it can only be reviewed against the real project.

**Further edge cases found in this review (fail-closed, not blockers):**
- A failed binding write *during renewal* leaves the binding attached to the revoked old session until that session's original expiry. The person is still legitimately signed in, but strictly it outlives that session by up to the remaining lifetime.
- A renewal arriving after expiry (inside the grace window) finds the binding pruned, so Firestore stays locked until **Retry unlock**.

## 6. Artifacts that a correct release would contain (none built or deployed)

| Target | Content |
|---|---|
| `firestore.rules` | `crmRole`, `ownerMfaKey`, `ownerMfaOk`, `hasPerm` gate, `ownerMfaSessions` deny. **Depends on earlier P1 rules (tickets, staffRoster, crmUsers privacy) and ~1,400 pre-existing lines** |
| `storage.rules` | `rawRoleClaim`, `ownerMfaOk` (cross-service), `roleClaim` gate |
| Backend (Cloud Run) | `owner_mfa.py`, `routers/auth.py`, `core/security.py`, `services/staff.py`, `core/audit.py`, **plus the earlier P1 backend changes they rely on** (`tickets`, `staff` lifecycle, `owner_mfa` TOTP, `crm_directory` roster) |
| Functions | `src/ownerMfa.ts`, `src/profiles.ts` |
| CRM (Hosting) | `lib/api.ts`, `app/login/page.tsx` |
| Android | `data/api/ApiClient.kt` |

## 7. Rollback plan (for when deployment is approved)

**Before deploying:**
- capture the deployed rules (`firebase firestore:rules:get`, or the Console's rules history);
- record the current Cloud Run revision and Hosting release.

**Rollback per target:**

| Target | How |
|---|---|
| Rules | redeploy the captured files. This is the first step if Owners are locked out |
| Backend | `gcloud run services update-traffic … --to-revisions <previous>=100` |
| CRM | Hosting "rollback" to the previous release |
| Functions | no built-in rollback; redeploy the previous build. ⚠ The previously deployed source is not identifiable from git while the tree is dirty |
| Android | keep the previous APK |

## 8. Recommendation

1. **Decide B2:** approve the per-session custom-token design, or explicitly accept the same-second residual.
2. **Resolve B1:** decide the release scope. Either review and commit the intended changes yourself on a release branch, or confirm that the whole working tree (including pre-existing work) is intended. Only then can an isolated, reviewable artifact exist.
3. **Run on the Mac:**
   - `tests/run-p1mfa-verify.command` (the 4 new checks);
   - `bash tests/run-phase1a-validation.sh` (repaired);
   - the CRM and device smoke tests in §4.
4. **Deploy following §6–7 yourself,** reviewing the cross-service IAM prompt, after 1–3.

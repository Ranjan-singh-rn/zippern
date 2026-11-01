# ZIPPER Phase 2 — Production Baseline, Release Isolation and Deployment Readiness Audit

25 Oct 2026 · branch `v5-scratch` · HEAD `1194e55` (5 Oct 2026 03:43 IST)

**What I did not do.** Nothing was deployed, committed, pushed, reset, cleaned, stashed, reverted, branched or worktree'd. I had no production access: there is no `gcloud` or `firebase` in the sandbox. No release copy was created, and no repository source file was changed: outside `outputs/`, `git status` is identical before and after this audit (596 entries).

**New or rewritten files (both untracked, under `outputs/`):**
- this report;
- `outputs/release/collect-production-baseline.sh`.

**Evidence labels:**
- **[RAN]**: I executed it.
- **[YOU]**: taken from your Mac runs.
- **[LOCAL]**: read-only inspection of local files.
- **[TO RUN]**: needs you, against production, using read-only commands.

---

## Summary

1. **The local evidence is complete and current (§A).** Every suite passes, and no source file changed after the run that covers it. Two things are still unverified: the CRM browser smoke test and the Android device smoke test.

2. **The production state is unknown for the backend, Functions, rules, indexes and Storage** until you run the baseline script (§B). Two components are already partly established from local evidence:
   - **CRM.** The last CRM deploy from this machine was built on **8 Oct at 01:38 IST**, from a dirty tree.
     - 26 changed CRM files predate that build.
     - **94 CRM files changed after it**, including all of the P1 work.
     - `zipper-crm/out` was rebuilt on 16 Oct and is *not* the deployed build: 0 of the 306 cached entries match its timestamps, and 83 of their paths are missing.
   - **Android.** The only APKs published from this machine are debug builds 13 and 14 (1 Oct) and 19 (20 Oct).
     - **None contains the Owner work layer**: zero hits for `/api/auth/signin`, `ownerWork` and `/api/auth/mfa/*`.
     - The current debug build does contain them, which confirms the check works.

3. **The MFA release cannot be assembled from HEAD or from the working tree (§D.1).**
   - The MFA code is not in HEAD.
   - P1 work for different features is entangled within the same files.
   - The working-tree closures pull in:
     - 20 untracked backend modules that are needed at startup;
     - 9 untracked Functions modules;
     - 36 untracked CRM files;
     - money-path Functions changes (`gifts.ts`, `calls.ts`, `wallet.ts`, `accounts.ts`).

4. **Recommendation: a baseline-anchored, per-component isolated release outside the repo (§D.3).** It starts from each component's exact production artifact, applies only reviewed MFA hunks, and builds and tests in isolation, with a manifest, hashes and a secret scan. Rules, backend and CRM are in scope; Android, Storage rules and indexes are left out. **Not started: it needs your approval.**

5. **Hard prerequisites, before any MFA backend serves Owners:**
   - **`OWNER_MFA_ENCRYPTION_KEY`.**
     - It is absent from `deploy.sh`.
     - If it is missing, Owners are blocked (fail closed): enrol and verify return 503, and the new CRM shows "not configured".
   - **Custom-token minting needs two things:**
     - the runtime service account holds Token Creator **on itself**;
     - the IAM Credentials API is enabled.

6. **P1-B (staff lifecycle), P1-D (tickets) and P1-E (directory privacy) are separable from MFA (§C.3).**
   - If P1-B does not ship, one hook needs porting: clear the bindings in the baseline `deactivate()`.
   - P1-D and P1-E need hunk-level splits in shared files.

---

## A. Local evidence

### A.1 Results

| Check | Source | Result | Current? |
|---|---|---|---|
| Android unit tests | [YOU] JUnit XML in `outputs/verify/test-results/testDebugUnitTest/` (34 files, all timestamped 2026-10-24T21:42:21–22Z = 03:12 IST) | **34 suites · 310 tests · 0 failures · 0 errors · 0 skipped.** `WorkModulesTest` has 15 tests, including the two P1-A3b wiring tests, the P1-A3 and P1-D tests, and the new `codeOnly` self-test | Yes. Newest Android source is 03:07 (`WorkModulesTest.kt`); the run was at 03:12 |
| Android build | [YOU] `work-verify-20261025-031215.log` | Gradle exit 0. 53 tasks: 1 executed (`testDebugUnitTest`), 52 up to date, because your focused run before it had already compiled the edited test | Yes |
| Rules (11 suites) | [YOU] `p1mfa-rules-20261025-025322.log` + `.summary` | **1,067 checks, 0 failures**, every suite exit 0 (table A.2). `rules_sha256` `26dac8f5…` = current `firestore.rules` | Yes. `firestore.rules` 02:40, `storage.rules` 02:41, `tests/` 02:46; run at 02:53 |
| Real-token claim and replay | [YOU] same log, lines 1295–1296 | `FACT custom session email=true email_verified=true phone_number=true`; `FACT replayed redemption auth_time differs from the confirmed one` | Yes |
| Backend | [RAN] 87 module logs, 03:21 | **87/87.** Each log has an explicit success line. 10 logs also contain tracebacks or simulated provider failures; these are expected negative-path output | Yes. Newest backend file is 02:51 |
| Functions | [RAN] full-repo mirror, 02:50 | `tsc` exit 0; **1518 pass / 0 fail** | Yes. Newest Functions file is 02:43 |
| CRM | [RAN] `tsc` 02:50:04, `npm test` 02:50:36 | Both exit 0 (19 spec suites + hooks lint) | Yes. Newest CRM source is 02:47 (`lib/api.ts`) |
| `run-phase1a-validation.sh` | [YOU] your report: every step exit 0 | Not independently checked: `validation-logs/` stays unopened by your rule | — |

**Staleness check [RAN].** `find -newer <run start>` returns 0 files for rules/tests, Android, CRM, backend and Functions. No rerun was needed.

### A.2 The 11 rules suites (from the summary file)

| Suite | Checks | Suite | Checks |
|---|---|---|---|
| storage | 136 | p1gov | 95 |
| p1mfa:storage | 60 | p1mfa | 175 |
| firestore | 114 | fx | 60 |
| phase1a | 255 | gov | 74 |
| ugp | 22 | rc | 58 |
| p1mfa:auth (real tokens) | 18 | **Total** | **1,067** |

### A.3 Still unverified

**1. CRM browser smoke test, against the local stack (`demo-zipper`):**
1. Owner enrols and verifies.
2. Custom-token redemption, then `/mfa/bind/confirm`.
3. An Owner Firestore screen loads (e.g. `/finance/withdrawals`).
4. Sign out, then sign in with the password only. Owner Firestore reads must be refused.
5. **Retry unlock** works after a failed mint.

**2. Android device smoke test:**
1. Personal phone login.
2. Owner work with the two-step code; a work screen loads.
3. Personal chat still works.
4. After a cold start, Owner work asks for the code again.

**3. Production IAM and configuration.** These need the §B script.

### A.4 Discrepancies between reports and logs

| Report | What it says | Now |
|---|---|---|
| `P1-FINAL-VERIFICATION-AND-DEPLOYMENT-GATES.md` | p1mfa 115, p1mfa:storage 35, Functions `ownerMfa` 13, Functions 1516, Android 307 | Superseded by the `mfa_sid` stage: 175 · 60 · 15 · 1518 · 310 |
| `P1-MFA-SID-ARCHITECTURE.md` §H | "ten rules suites … Functions (1516) and Android (307)" | 11 suites · 1518 · 310 |
| `P1-MFA-SID-IMPLEMENTATION-REPORT.md` | rules, `run-phase1a-validation` and Android marked **[NOT RUN]**; backend "86/87" (moderation timing flake) | You have since run all three (pass). Backend rerun: 87/87 (`test_moderation` 264/264) |
| `P1-EXECUTION-REPORT.md` | "Android NOT RUN since D/A3/E; last green 305" | 310 / 0 |
| partner-session counts: 541 → 542 → 543 across reports | Not a discrepancy | The route inventory grew by one route per stage (`/mfa/bind/confirm` last) |
| `docs/workstream-0/PHASE-B-DEPLOY-DRY-RUN.md` (in HEAD) | "two hosting caches from 30 Sep" | Both caches now date from **8 Oct**: a CRM and applinks deploy happened after HEAD |

---

## B. Production baseline (read-only)

### B.1 How to run

From the repository root, after `gcloud auth login` with an account that can read `zipper-83816`:

```
bash outputs/release/collect-production-baseline.sh                 # metadata, ~1-3 min
bash outputs/release/collect-production-baseline.sh --with-sources  # + source archives behind the live backend/Functions
bash outputs/release/collect-production-baseline.sh --with-apk      # optional: + newest published APK per channel, scanned, then deleted
```

Output goes to `~/zipper-baseline/<UTC time>/` (mode 700), **outside the repo**.

**Please send me these files:** `COMPARISON.txt`, `PARTITION-SUMMARY.txt`, `UNAVAILABLE.txt`, `cloudrun-summary.txt`, `cloudrun-env-NAMES.txt`, `iam-apis-secrets.txt`, `functions-list.txt`, `android-update-VERSIONS.txt`. **Do not send** `stderr.log` or the extracted `*-src` folders without checking them first.

### B.2 What it collects

| Area | Collected | How |
|---|---|---|
| **Cloud Run `zipper-api`** | URL; traffic split; serving revision(s) and creation times; image digest; runtime service account; revision annotations (build-source location if present); last 30 revisions; Cloud Build history (regional and global); Artifact Registry cleanup policy and retained images (needed for rollback) | `run services/revisions describe/list`, `builds list`, `artifacts … describe/list` |
| Cloud Run environment | **Names only**, plus secret references (`NAME ← secret:version`). Flags the presence of `OWNER_MFA_ENCRYPTION_KEY`, `OWNER_MFA_REQUIRED`, `ENFORCE_MOBILE_SESSION` and the emulator hosts | Projection without `value`; values are never requested |
| **Functions** | All functions with generation, state and last update; full metadata for `backfillPublicProfiles`, `syncStorageRoleClaim` and `settleGift` (the gen2 reference) incl. source archive location and env-var **names**; newest objects in `gcf-sources-*`, `gcf-v2-sources-*`, `run-sources-*`, `*_cloudbuild` | `functions list/describe`, `storage ls` |
| **Firestore and Storage rules** | Every release and ruleset; the **deployed rules text** (`firestore.rules.DEPLOYED`, `storage.rules.DEPLOYED`); ruleset history with rollback candidates | Firebase Rules API (GET) |
| **Indexes** | Deployed composite indexes and field overrides | Firestore Admin API (GET) |
| **Hosting** | `zipperlive` and `zipper-83816`: live and previous version, live config (rewrites), the **full file list with hashes** | Hosting API (GET) |
| **IAM** | Token Creator members **on** the runtime service account (self-binding yes/no); its project roles; the Storage service agent's roles (`firebaserules.firestoreServiceAgent`); enabled APIs (incl. `iamcredentials`); Secret Manager **names**; OWNER_MFA secret present/absent | `get-iam-policy`, `services list`, `secrets list` |
| **Android** | `appConfig/androidUpdate`: version, mandatory flag, minimum supported version, `publishedAt`, sha256 per ABI (URLs omitted); every `appBuilds` object **md5-compared** to the local `zipper-app/build/published/` cache | Firestore REST GET; `storage objects list` |
| `--with-sources` | The archive behind the serving Cloud Run revision and behind `backfillPublicProfiles`. Secret-looking files are **counted and named, never extracted**; archive deleted after extraction | `storage cat` |
| **Comparisons [local]** | Covered in the list below | `git show`, hashes |

The comparisons cover:
- **Deployed rules.** Compared with HEAD, the pre-P1 tree and the working tree, with line deltas, plus an audit of Owner checks that bypass `crmRole()`.
- **Indexes.** Indexes that exist only in production, i.e. the ones an index deploy would offer to delete.
- **Hosting.** The live files compared with the 8 Oct deploy cache.
- **Backend and Functions source files.** Each one classified as same as HEAD, same as the pre-P1 tree, same as the working tree, or only in production.
- **Deploy-time partition (`PARTITION.txt`).** For each component, the changed files last modified before or after its live deploy. On macOS, untracked files created after it are listed too.

### B.3 Safety properties and how I tested them

| Property | How it is enforced | Tested [RAN] |
|---|---|---|
| Read-only | **Guard.** The script refuses to start if any executable line contains a mutating `gcloud` or `firebase` verb, `gsutil`, a non-GET `curl`, a mutating `git` verb, or an `rm` outside its output folder | Clean on itself. **23 injected commands all refused**, incl. `run deploy`, `update-traffic`, `hosting:clone`, `add-iam-policy-binding`, `services enable`, `secrets versions access`, `storage rm/cp`, `curl -X POST`, `git stash`, `rm -rf /tmp/x`. 4 benign commands are not flagged |
| Token never exposed | It stays in a variable and reaches `curl` through a file descriptor (`-H @<(…)`) | A fake `curl` checked its argv: token absent; header present |
| No secrets or e-mails stored | Env values dropped in memory; keys named like a token redacted; personal e-mails redacted (service accounts kept) | Dry run with fake `gcloud`/`curl` seeded with an e-mail, an env secret, a download token and a `.env` file: **0 leaks in all 53 output files** |
| Source archives | Secret-looking names not extracted; path traversal and links skipped; extracted into a new folder; archive deleted | `.env` and `serviceAccountKey.json` were not extracted; `../evil.txt` was skipped; no archive left |
| Degrades cleanly | Every step is non-fatal; gaps are listed | An everything-denied run: exit 0, 14 gaps, no tracebacks |
| Portability | Bash 3.2 constructs only; the helper uses Python stdlib and the 3.9 grammar (macOS CLT python) | `bash -n`; `ast.parse(feature_version=(3,9))` |
| Owner-gate audit is meaningful | Flags Owner authority that bypasses `crmRole()` | **0 hits** on HEAD, the pre-P1 tree and the working tree; catches all 3 injected bypasses (a direct `crmUsers` role read, a role claim, a helper) |

### B.4 What cannot be retrieved or verified

| Component | Limitation | Consequence |
|---|---|---|
| **CRM source** | Hosting stores built assets only. A file edited both before and after 8 Oct has lost its 8 Oct state | Production CRM source must be **reconstructed and verified** by rebuilding and comparing chunk hashes (§D.3). Chunks that do not match point to such files; for each, you choose HEAD's version or the current one |
| Cloud Run source | Only if the Cloud Build archive still exists (bucket lifecycle) | If it is gone, the backend baseline is a reconstruction (weaker) |
| Functions source | Only if the archive location is exposed and retained | Same |
| `.env` files, secret values | Never read, by design | The values used for Functions builds and deploys must come from you at deploy time |
| Who deployed | Redacted | n/a |
| APK source provenance | An APK has no source revision | Only md5 identity against local builds, plus feature markers |
| Hosting version and image retention settings | Partly console-only | Rollback depth must be confirmed in the console |
| Storage rules, if never released | There is no ruleset to fetch | Production runs whatever the bucket was created with or edited in the console; the script reports "no release" |

### B.5 Already established locally, without production access [LOCAL]

1. **CRM deploy cache.** `.firebase/hosting.emlwcGVyLWNybS9vdXQ.cache` (base64 of `zipper-crm/out`) has 306 entries; the newest file in it dates from 8 Oct 01:38:16 IST, and the cache was written at 01:46:34 IST. The current `out/` is an unrelated 16 Oct rebuild.
2. **CRM partition by that build time:**
   - changed **before** it: 9 modified + 17 untracked;
   - changed **after** it: 55 modified + 39 untracked, incl. `lib/api.ts`, `lib/auth.ts`, `components/AuthProvider.tsx` and every P1 file.
3. **Published APKs.** Only the `debug` channel was ever published from this machine (versionCode 13 and 14 on 1 Oct, 19 on 20 Oct). Dex markers are 0 for `/api/auth/signin`, `/api/auth/mfa/verify`, `/api/auth/mfa/bind/confirm` and `ownerWork`; 3 for `startMobileSession`. The work layer's files date from 23 Oct onwards.
4. **HEAD's own dry-run document** (`docs/workstream-0/PHASE-B-DEPLOY-DRY-RUN.md`, 5 Oct) records:
   - nothing locally records the deployed Functions, rules or index state;
   - an unfiltered `firebase deploy --only functions` deletes production functions missing from source (D1);
   - 9 functions are gen2 and a generation change fails mid-deploy (D2);
   - `ENFORCE_MOBILE_SESSION` must stay off;
   - HEAD's `storage.rules` makes the KYC signup documents world-readable.

---

## C. Release dependency map

### C.1 Categories

1. **MFA**: required for Owner MFA.
2. **Prerequisite**: required for MFA to work or to be safe.
3. **Independent**: an independent feature; exclude it, or ship it as its own release unit.
4. **Unrelated**: existing work; leave it untouched and out of the release.
5. **Uncertain**: whether production already has it decides; the §B baseline settles it.

Deltas are "pre-existing" (HEAD → pre-P1 backups in `outputs/p1-exec/before/`) and "P1" (pre-P1 → now), measured in lines [RAN].

### C.2 Map

**Firestore rules** (`firestore.rules`, M). The whole file deploys. Pre-existing delta +1224/−190; P1 delta +120/−37.

| Item | Category | Depends on / relation to baseline |
|---|---|---|
| MFA hunks: `crmRole()` → `superadmin_mfa_pending`; `ownerMfaOk()`; `ownerMfaBindingLive()`; `hasPerm()` refusal; `ownerMfaSessions` deny-all | **1** | Uses only `isCrmUser`, `crmRole` and `hasPerm`, which exist in HEAD (lines 35, 43, 192), so they **port onto any baseline that has them**. Re-run the Owner-gate audit on the deployed text |
| P1-A1 hunks (internal tickets staff-only; `coinPurchaseRequests` list scoping, a financial read) | 3 | Independent |
| P1-D hunks (client writes to tickets refused) | 3 | Needs the backend tickets API, otherwise CRM ticket edits fail |
| P1-E hunks (staff contacts least-privilege, `staffRoster`) | 3 | Needs the `staffRoster` backfill and its index *before* the rules |
| Combined A3b+E hunk (30 lines) | 1 + 3 | **Must be split by hand** |
| 100 pre-existing hunks | **5** | The baseline reports whether deployed = HEAD, pre-P1 or neither |

**Storage rules** (`storage.rules`, M). Pre-existing +558/−90; P1 +33/−1.

| Item | Category | Notes |
|---|---|---|
| MFA hunk (`roleClaim()` via `firestore.get` of `ownerMfaSessions`) | **3 for this release** | It is part of the claim-based design. That design needs custom claims written by `syncStorageRoleClaim` (a Function not in HEAD) and by backend `storage_claims.py`, and needs the Storage service agent role (the CLI offers to grant it on the first cross-service deploy, which is an **IAM change**). Production has no CLI-deployed Storage rules |
| Claim-based Storage design (pre-existing) | 5 → separate project | Note: `/kyc/agencies/signup/{file}` is still `allow get: if true` in the working tree (list off) |

**Indexes** (`firestore.indexes.json`, M). Pre-existing +747/−533; P1 +14 (E `staffRoster`).

**MFA needs no index, so indexes are not deployed in this release.** A full index deploy offers to delete production-only indexes, and the baseline lists them.

**Backend.** The deploy unit is the whole `backend/` directory; the image contains `app/`, `scripts/` and `requirements.txt` (`requirements.txt` is unchanged vs HEAD).

| Item | State | P1 Δ | Category | Notes |
|---|---|---|---|---|
| `services/owner_mfa.py` | ?? (new) | +781 | **1** | Imports `config`/`audit`/`roles`/`mongo`, all present in HEAD. Lazy imports: `firebase.create_custom_token` (P1 hunk) and `notices` (untracked pre-existing, **guarded**: without it the reset notice falls back to e-mail) |
| `routers/auth.py` MFA routes incl. `/mfa/bind` and `/mfa/bind/confirm` | M | +213/−3 | **1** | Needs `_session_expiry` (P1 hunk) and HEAD's `verify_session`/`require_owner_provisioner` |
| `core/security.py` (MFA claim, `_session_expiry`, renewal `carry_binding`) | M | +39/−12 | **1** | HEAD already has the `sessions` store with `jti` and revocation |
| `core/deps.py` MFA gate | M | +33 | **1** | `MFA_PENDING_ROUTES` comes from `owner_mfa` |
| `config.py` (6 `owner_mfa_*` settings) | M | +17 | **1** | `owner_mfa_required` defaults to **True** |
| `db/mongo.py` (`OWNER_MFA`) | M | +3 | **1** | |
| `core/audit.py` (`OWNER_MFA_*`) | M | +28 | **1** (split) | Same region as the B constants (`STAFF_*`) and D constants (`TICKET_*`) |
| `db/firebase.py` (`create_custom_token`) | M | +13 | **1** | Appended at the end of the file |
| `main.py` `expose_headers=["X-Zipper-MFA-Required"]` | M | +2 of +6 | **1** (split) | The other +4 is P1-D: the tickets import and include |
| `services/staff.py` hook in `change_role()` | M | | **1** | `change_role()` exists in HEAD, so the hook ports |
| **Port**: `clear_all_bindings` in the baseline's `deactivate()` | — | | **2** | HEAD's `deactivate()` sets `crmUsers.isActive=false` (Firestore closes through `isCrmUser()`). The hook closes the up-to-7-day window if the Owner is reactivated |
| `services/storage_claims.py` (strip `mfa_sid`) | ?? (pre-existing) | +4/−1 | 1 *if present in baseline* | Defence in depth only |
| `scripts/remove_gate_answers.py` | ?? | new | 1 (post-rollout) | Not run; needs separate approval |
| P1-B: `routers/staff.py` suspend/reactivate (+55), `_change_status` and notices in `services/staff.py` (+338/−116), `account_state.py` suspended refusal (+6) | M | | **3** | Needs untracked `partner_applications.py`, `notices.py` and `storage_claims.py` |
| P1-D: `routers/tickets.py`, `services/tickets.py` | ?? (new) | +75 / +553 | 3 | Mandatory while `main.py` includes the tickets router |
| P1-E: `services/crm_directory.py` (+40/−2), `scripts/backfill_staff_roster.py` | M / ?? | | 3 | |
| P1-G: `scripts/survey_legacy_roles.py` | ?? | | 3 | |
| Pre-existing changes inside MFA files: `security` +107/−3, `deps` +104/−6, `config` +53/−5, `mongo` +125/−2, `audit` +30, `main` +34/−1, `firebase` +888/−2, `auth` +11/−1, `staff` +150/−6, `crm_directory` +255/−29, `account_state` +91/−12, `email` +5 | M | | **5** | `--with-sources` classifies them file by file |
| Everything else in `backend/` (the directory has 56 M and 92 ?? in total) | | | 4 | |

**Functions.** The build covers the whole codebase. `firebase deploy --only functions:NAME` updates just that function, but uploads the whole directory.

| Item | State | Category | Notes |
|---|---|---|---|
| `src/ownerMfa.ts` | ?? (new) | **1** | |
| `src/profiles.ts` hunk: `backfillPublicProfiles` requires a live binding | M (+7) | **1** | Exported in HEAD, so likely deployed. It is the only Owner-authorised callable. The other Owner check (`index.ts` ~3081) validates an approval document whose writes are already MFA-gated by the rules |
| `src/storageClaims.ts` + `syncStorageRoleClaim` (not in HEAD) | ?? / new function | 3 | A full deploy would **create** this trigger |
| `src/index.ts` (imports `syncClaim` from untracked `storageClaims.ts`, line 28) | M (+659/−261) | 4/5 | Without that file the build fails |
| Build closure: 32 modules = 9 ?? + 17 M + 6 clean, incl. **money-path** `gifts.ts`, `calls.ts`, `wallet.ts`, `accounts.ts` | | **4** | Must not ship with MFA |

**CRM.** The deploy unit is the whole static export (Hosting target `production` → `zipperlive`). The build closure has 192 files: 36 ??, 62 M, 94 clean.

| Item | State | Category | Notes |
|---|---|---|---|
| `app/login/page.tsx` | M (pre-P1 = HEAD; P1 +256/−254) | **1** | |
| `lib/api.ts` MFA functions (`mfaStatus/Verify/EnrolStart/EnrolConfirm/Bind`, `redeemOwnerBinding`, `settleBinding`, `firestoreBindingOf`) | M (+214/−2) | **1** (split) | Same file as B (`staffStatus`, suspend/reactivate) and D (`tickets`, `newRequestId`) |
| `lib/auth.ts` gate removal | M (+11/−19) | **1** (split) | Also carries E/D lines |
| `app/team/page.tsx` Observer MFA reset | M (+141/−6) | **1** (split) | Same file as the B suspend/reactivate UI |
| **Porting note** | | **2** | The P1 hunks add only `@/lib/api` and `firebase/auth` imports. But the pre-P1 `api.ts` (+323/−11 vs HEAD) was last edited on **20 Oct**, after the 8 Oct build, so production does not run it. For `auth.ts` (+205/−39) the date of its pre-existing edits is unknown (category 5). The MFA hunks must be ported onto the reconstructed production versions |
| P1-D pages and libs (`tickets`, `tech/tickets`, `feedback`, `operations/feedback`, `lib/{firestore,tech,operations}.ts`) | M | 3 | |
| 26 files changed before 8 Oct (9 M, 17 ??) | | **5** (likely live) | Part of the reconstructed baseline |
| 82 non-P1 files changed after 8 Oct (new pages incl. frozen-money, recharges, transfers, role-appeals; financial screens) | | **4** | Must not ship (the other 12 of the 94 are the P1 files) |
| Build config: the same 10 `NEXT_PUBLIC_*` names in HEAD and the working tree | | 2 | Values come from `zipper-crm/.env.local` at build time; never opened, never in a manifest |

**Android.** Category 3 for this release.
- The Owner work layer (17 untracked files in `data/work` and `data/api`, plus `ui/screens/work`) and all P1 Android files belong to it.
- Published builds do not contain it, so the MFA rules cannot break a published Owner screen.
- `versionCode` 19 equals the published version, so any future build must be ≥ 20.
- Naming note: P1-**B3** (suspension) is unrelated to the earlier Android "B3" work layer.

**Configuration**

| Item | Category | Notes |
|---|---|---|
| `OWNER_MFA_ENCRYPTION_KEY` (Secret Manager → Cloud Run) | **1, hard prerequisite** | Missing = enrol/verify 503; the new CRM blocks Owners; with `owner_mfa_required=True` Owners are confined to MFA routes. Never destroy key versions: TOTP secrets are encrypted with it |
| `OWNER_MFA_REQUIRED` | **1, rollout control** | `false` for stage 1 (§D.4) |
| `deploy.sh` `--set-env-vars` / `--set-secrets` (replace the whole list) | 2 | Would also drop any production-only env vars or secrets; the baseline lists their names |
| `ENFORCE_MOBILE_SESSION`; emulator host settings (3, default `""`) | 4 | Must stay unset in production |
| `functions/.env` exists, and `firebase.json` does not ignore `.env` | 5 | A Functions deploy sets env vars from it, and the upload likely includes the file. The deployed env-var **names** come from the baseline |
| `backend/.env` and `.env.local` exist; no `backend/.gcloudignore` or `backend/.gitignore` | 2 | Likely uploaded into the Cloud Build source archive (the image excludes them via `.dockerignore`). `--with-sources` counts them. Add a `.gcloudignore` in the release folder only |
| `firebase.json` storage object fix; two Hosting targets | 3 / 2 | Deploy Hosting as `--only hosting:production` |

**IAM**

| Item | Category | Notes |
|---|---|---|
| Token Creator **on** the runtime service account, plus `iamcredentials` enabled | **2** | `deploy.sh` grants it (for face-image signing), so it may already exist. Without it, minting fails closed |
| Storage service agent `roles/firebaserules.firestoreServiceAgent` | 3 | Only needed for Storage rules |
| Functions service account Token Creator | 4 | Quick sign-in; pre-existing |

**Tests** (run in the release copy, never deployed)

| Item | Category |
|---|---|
| Backend `test_p1_owner_mfa` (68), `test_p1_owner_mfa_binding` (50), `test_session_lifetime` (247), `test_staff_revocation` (81, incl. B), `test_partner_session` (route inventory), `test_money_permissions` (fixture) | 1 |
| Functions `ownerMfa.test.js` (15) | 1 |
| Rules `p1mfa` (175), `auth.p1mfa` (18), Owner fixtures in 7 suites; `run-p1mfa-verify.command` | 1 |
| `storage.p1mfa` | 3 |
| Android `WorkModulesTest` | 3 |
| **Caveat** | The suites target the working-tree rules. Against "baseline + MFA" rules, suites for features the baseline lacks will fail, so the release copy needs a curated subset |
| `tests/run-phase1a-validation.sh.bak` still names the production project | 4: leave it, never run it |

**Deployment config**

`deploy.sh` is unsuitable for this release (category 4: leave it untouched):
- it ships whole directories;
- it replaces env vars and secrets;
- it grants IAM;
- it includes steps that deploy rules, indexes, Storage rules, all Functions and both Hosting targets.

Leave `deploy-crm.command` and `setup-email-and-deploy.command` (M) untouched, and do not run them.

### C.3 Phase 1 workstreams vs MFA

| Workstream | Relation to MFA | Category | If shipped with MFA | If omitted |
|---|---|---|---|---|
| **A3/A3b Owner MFA** | — | 1 | — | — |
| **B staff lifecycle** (B1–B4, F) | One MFA hook lives in its new `_change_status()` | 3 (+ port in cat. 2) | Brings untracked `partner_applications.py`, `notices.py`, `storage_claims.py`, the CRM team UI and `api.ts` staff calls | Port the binding clear into the baseline `deactivate()`. There is no suspension to hook |
| **D tickets lockdown** | Shares `main.py`, `audit.py`, `api.ts`, `ModulesOps.kt` and rules hunks (A1+D) | 3 | Needs rules + API + CRM together | Strip the include, constants and hunks during the split |
| **E directory privacy** | Shares the A3b+E rules hunk and `auth.ts` | 3 | Order: backfill → index → rules | Split the rules hunk |
| **Role permissions**: A1 (rules scoping), A2 (analysis only), department decisions (not implemented) | Independent | 3 / 4 | — | — |
| **Account/session enforcement**: B3 suspension refusal; `ENFORCE_MOBILE_SESSION`; API session revocation | MFA relies only on HEAD's session store | 3 / 4 / — | — | — |

### C.4 What breaks if a file is omitted

| Omitted | Effect |
|---|---|
| `owner_mfa.py`, with the auth/deps/security hunks shipped | Runtime `ImportError` on Owner and MFA requests, sign-in and renewal |
| `isolation.py`, `notices.py`, `storage_claims.py`, `partner_applications.py`, `routers/tickets.py` … (20 untracked modules on the working-tree startup path), with the working-tree `main.py`/`config.py`/`staff.py` shipped | **Backend does not start** |
| `create_custom_token` (`firebase.py` hunk) | Minting fails, so bindings fail (fail closed: Owners keep API access but have no Firestore) |
| `OWNER_MFA_ENCRYPTION_KEY` | Owners are blocked from finishing sign-in (fail closed) |
| Token Creator / `iamcredentials` | Every Owner sees "locked" + Retry; no Owner Firestore |
| `storageClaims.ts`, with the working-tree `index.ts` shipped | Functions build fails |
| `ownerMfa.ts`, with the `profiles.ts` hunk shipped | Functions build fails |
| MFA rules shipped, backend MFA not shipped | **All Owners lose Firestore access** (`superadmin_mfa_pending`) |
| CRM MFA build shipped, backend MFA not shipped | Owner login fails at `/api/auth/mfa/status` |
| Rules before every Owner has an active binding | That Owner loses Firestore until they sign in again with MFA |
| E rules without the `staffRoster` backfill | Staff pickers are empty |
| D rules without the tickets API | CRM ticket edits are refused |
| `OwnerWorkFirebase.kt`, with the P1 `ApiClient.kt` shipped | The Android build fails (Hilt) |
| The baseline `deactivate()` hook port | Deactivated-then-reactivated Owner keeps an old binding for ≤ 7 days |

### C.5 Why shipping whole files snowballs [RAN]

**Backend (working-tree versions):**
- The MFA entry modules close over 19 modules: 4 untracked, 13 modified, 2 clean.
- `app.main` startup closes over 66 modules: **20 untracked**, 26 modified, 20 clean. With lazy imports it is 69.

**Functions and CRM:** see the 32-module (Functions) and 192-file (CRM) closures in §C.2.

---

## D. Release isolation options (assessment only — nothing created)

### D.1 Why `git archive HEAD` alone is unsafe

1. **HEAD does not contain the change.** `owner_mfa.py`, `ownerMfa.ts`, `OwnerWorkFirebase.kt` and every P1 hunk are uncommitted.
2. **HEAD lacks required dependencies.** `git archive` drops untracked files, and the MFA paths import `notices.py`, `storage_claims.py`, `partner_applications.py`, `storageClaims.ts`, `crmDoor.ts` and others.
3. **HEAD is not production.**
   - The CRM was deployed on 8 Oct from a tree with 26 changes beyond HEAD. A HEAD-based CRM would silently revert them.
   - Debug APK 19 was built on 20 Oct, while HEAD declares `versionCode` 14. The updater refuses downgrades.
   - Backend, Functions and rules may also be ahead of or behind HEAD. Nothing local records them, which is exactly what §B establishes.
4. **HEAD may also ship undeployed commits** (e.g. `c1bd2a7` quick-login, and the Phase-B functions the 5 Oct dry run had not yet deployed) if production is behind it.
5. **HEAD's configuration would mis-deploy:**
   - its `firebase.json` has the Storage array form, so `deploy --only storage` fails;
   - its `deploy.sh` has no MFA key and replaces env vars and secrets;
   - its `storage.rules` has the world-readable KYC rules.
6. **No provenance.** An archive of HEAD says nothing about what production runs, so it cannot be diffed into a reviewable "production → release" change.

### D.2 Options

| Option | Fidelity to production | Isolation | Verdict |
|---|---|---|---|
| 1. Existing deploy scripts on the working tree | None | None: ships 596 changes incl. money-path Functions, 94 post-deploy CRM files, P1-D/E, never-deployed Storage rules, possible index deletions; replaces env and secrets; grants IAM | **Rejected** |
| 2. `git archive HEAD` (+ overlay MFA files) | Wrong baseline (D.1) | Overlays break: files are entangled at hunk level | **Rejected** |
| 3. Working tree minus "unrelated" files | None | Hunk-level entanglement (`api.ts` A3+B+D, team page A3+B, rules A1/A3b/D/E, `main.py` A3+D, `audit.py` A3+B+D) and the closures in §C.5 | **Rejected** |
| **4. Baseline-anchored isolated release** | Exact for rules; exact for backend and Functions if the archives exist; CRM by verified reconstruction | Only reviewed hunks; per component; outside the repo | **Recommended** |
| 5. Option 4 recorded in git (baseline imported as a commit on a new branch, reviewed patch on top, `git archive` of that commit) | Same as 4 | Same + an auditable diff | **Optional layer.** Needs your approval to create a branch and commits |

### D.3 Recommended approach, per component (for approval)

**General shape:**
- **Release folder** outside the repo, e.g. `~/zipper-release/<id>/`.
- **One reviewed patch per component.**
- **Build and test only inside the release folder.**
- **`MANIFEST.json`.** It holds:
  - the baseline references (revision, image digest, archive object and generation, ruleset name, Hosting version);
  - the patch sha256;
  - every file's path, sha256 and origin (baseline, patch or new);
  - the build artifact hashes (rules text, Functions zip, CRM `out/` per file, backend source tarball, then the image digest after build);
  - the test commands with exit codes and counts;
  - the deliberate exclusions (`outputs/`, `validation-logs/`, `.env*`, keys, `*.jks`).
- **Secret scan, before any deploy.**
  - File names are checked with the same patterns as the script.
  - Content is checked for private-key headers, service-account JSON, `mongodb://user:pass@`, SendGrid keys and JWT-looking strings.
  - The Firebase web API key is allow-listed because it is public by design.
  - Findings are reported as file + rule only. **Anything above 0 blocks the release.**

| Component | Baseline | Patch | Validate | Deploy later (separate approval) |
|---|---|---|---|---|
| Firestore rules | Deployed ruleset text | The 5 MFA hunks only | The diff deployed → release equals exactly those hunks; Owner-gate audit = 0; emulator: `p1mfa` + `auth.p1mfa` + suites valid for the baseline | `firebase deploy --only firestore:rules` from the release folder |
| Backend | Cloud Run source archive | MFA hunks (§C.2 category 1) + `deactivate()` port + a `.gcloudignore` excluding `.env*`, keys, `.venv`, tests | `app.main` import check; MFA backend tests adapted to the baseline | `gcloud run deploy --source … --no-traffic --tag mfa`, with `--update-secrets`/`--update-env-vars` (merge, not replace); test the tag URL, then migrate traffic |
| Functions | Archive of `backfillPublicProfiles` (rebuild `lib/` from `src/`) | `ownerMfa.ts` + `profiles.ts` hunk | `tsc` + `ownerMfa` tests | `firebase deploy --only functions:backfillPublicProfiles`; `.env` must match the deployed names |
| CRM | **Reconstruction**: HEAD + the 26 pre-8 Oct files; `npm ci` (lockfile unchanged since 30 Sep); build; compare chunk names and hashes with the live version. Each mismatch is resolved per file by you (§B.4) | Login page, the MFA functions in `api.ts`, the `auth.ts` gate removal, the team-page Observer reset (no B UI) | `tsc`, `npm test`, `verify-out`, secret scan | `firebase deploy --only hosting:production` |
| Android, Storage, indexes | — | none | — | Not in this release |

**If an archive is gone,** that component's baseline falls back to a reconstruction using `PARTITION.txt`. Every "uncertain" file then needs your decision before I continue.

### D.4 Rollout order (each step separately approved; none run by me)

0. **Prerequisites:**
   - The IAM self-binding and API are verified by the baseline. Any grant is your change to make.
   - The `OWNER_MFA_ENCRYPTION_KEY` secret is created; that is a configuration change, yours to make.
1. **Backend with MFA code and `OWNER_MFA_REQUIRED=false`.**
   - Deploy with no traffic, test on the tag URL, then migrate traffic.
   - The old CRM keeps working, because MFA is not enforced.
2. **CRM with MFA.**
   - Owners enrol or verify at their next login, and their bindings are minted.
   - IAM must be good by this step, or Owners see "locked".
3. **Set `OWNER_MFA_REQUIRED=true`.** This creates a new revision.
4. **Firestore rules with the MFA gate,** once every active Owner has a binding.
5. **`backfillPublicProfiles`.**
6. **Post-rollout `remove_gate_answers.py`.**

---

## E. Rollback readiness

| Target | Procedure | Prerequisites | Gaps now | Speed |
|---|---|---|---|---|
| Cloud Run | Send traffic back to the previous revision. Softer option: `OWNER_MFA_REQUIRED=false` | Previous revision name and **its image still in Artifact Registry**; the new revision deployed with `--no-traffic` | Retention and cleanup policy unknown (the baseline lists them); `deploy.sh` deploys with traffic | Seconds |
| Functions (`backfillPublicProfiles`, gen1) | Redeploy the baseline source for that one function | Baseline archive (extracted without `.env`) + its env values | No archive yet; `.env` contents unknown to me | Minutes. Low impact: an admin callable; the change only adds a refusal |
| Firestore rules | Re-release the previous ruleset (Console → Rules → History, or deploy the saved `firestore.rules.DEPLOYED`) | Ruleset name and text, saved by the baseline | None once the baseline has run | ~1 min, up to ~10 for open listeners |
| Indexes | None in this release; indexes are additive | Never accept a deletion prompt | — | — |
| Storage rules | Not in this release | — | Production rules unknown | — |
| Hosting (`zipperlive`) | Console → Hosting → release history → Roll back (or clone the previous version to live) | `PREV` version from the baseline; version retention | Retention setting unknown | Seconds |
| Android | Not in this release. In general there is no downgrade: roll forward with `versionCode` ≥ 20, or restore `appConfig/androidUpdate.<channel>` to stop rollout | sha256 and size (baseline) + public URLs from `appBuilds` | No documented restore procedure | Minutes; installed builds stay |
| MFA key secret | Never destroy versions | — | — | — |
| Data left behind (`ownerMfaSessions`, Mongo `owner_mfa`, audit rows) | Leave it: old code ignores it, and re-rollout keeps enrolments; baseline rules default-deny `ownerMfaSessions` | — | — | — |

**Rollback order:**
1. Rules, if Owners are locked out of Firestore. This is the fastest step and restores pre-MFA access.
2. `OWNER_MFA_REQUIRED=false`, if Owners are blocked at the API.
3. Hosting and Cloud Run traffic **together**. The new CRM needs the MFA routes, while the old CRM works with the new backend while `REQUIRED=false`.
4. Functions last.

**Overall gaps:**
- no baseline yet;
- no rollback rehearsal;
- unknown retention for images and Hosting versions;
- deploy tooling uses replace semantics;
- no production smoke checklist;
- Android cannot be downgraded.

---

## F. Decisions I need from you

1. **Run the baseline script** (metadata first, then `--with-sources`) and send me the files listed in §B.1.
2. **Approve option 4** (§D.3), or choose another. Please also decide on option 5 (git-recorded), which would need a branch and commits.
3. **P1-B:** ship it later (I port the `deactivate()` hook into the MFA patch) or together with MFA?
4. **Approve a release folder outside the repo** (proposed: `~/zipper-release/<id>/`). Nothing will be created until you do.
5. **Do the CRM browser and Android device smoke tests** (§A.3) on the local stack before any deploy step.
6. When you reach §D.4 step 0: the secret creation and any IAM grant are yours to make.

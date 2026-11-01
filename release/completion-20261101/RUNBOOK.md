# ZIPPER completion release 20261101 — production runbook (prepared, NOT executed)

Every step that changes production needs **its own explicit approval** (the `STEP-n` line in `APPROVAL-COMMANDS.txt`)
and **the typed word** the script asks for. Nothing in this folder has been run against production.

**Where:** `~/Documents/Projects/zippern/release/completion-20261101/`. Run each script from Terminal in that folder
(`./NN-name.command`, or double-click). Project `zipper-83816`, region `asia-south1`.

**How the scripts protect themselves**
- Each refuses to run unless every file listed in `SCRIPTS.sha256` is unchanged (exit 2).
- Each refuses a dirty working tree (anything modified or untracked; the only tolerated untracked paths are the
  emulator results folders `hotfix/rules-20261101/results-<UTC>/` and `tests/results-rc2-<UTC>/`), and a HEAD or
  any recorded tree/file hash that differs from `RELEASE.txt` (exit 3). Only committed code is deployed.
- Each production change sits on one line tagged `#MUT-…`, behind a typed word (anything else: exit 4, nothing changed).
- Evidence: `production/<id>-<UTC>/SUMMARY.txt` (+ `stderr.log`, which may name the operator account — do not share).
  No secret, environment value or person's address is printed or saved (addresses are masked `x***@domain`).
- State files written by the scripts: `production/backend-revision.txt` (11: NEW and BASE revision, digest, HEAD),
  `production/crm-live.txt` (50: the new Hosting version and the previous one).

**Rules for every step**
- Never `--to-latest`; traffic moves by revision NAME only. Never route traffic to `zipper-api-00048-pit`.
- Never delete `zipper-api-00046-siw` (BASE, serving 100% today) or the template/key revision `zipper-api-00047-9cj`.
- Never print, paste or `versions access` a secret. Never `firebase deploy` from the working tree by hand.

## One-time setup (local, no approval needed)
1. Commit the release (code + this folder, including `SCRIPTS.sha256`). If you edit any listed file (e.g. names into
   `WAVE_2A_MAIL`/`WAVE_2A_HYGIENE` in `rel_common.sh`), run `tools/write-scripts-sha256.command` after review, commit.
2. `./make-release-txt.sh` (no argument) — writes the git-ignored `RELEASE.txt`: HEAD, BASE_COMMIT + BASE_REF (the
   functions/ that 29 rolls back to = branch `prod-live-20261030`, resolved by its full ref
   `refs/heads/prod-live-20261030` to `4e21b7f14f7c…`: the exact production Functions tree — 20 Oct baseline + the
   SendGrid wave-A files live since 30 Oct; tag `prod-live-20261030-tag`; refused if the branch moved off that commit) and
   sha256 tree hashes of `backend/`, `functions/`, `functions/src/`, `zipper-crm/` (no node_modules/.next/out),
   `firestore.rules`, `storage.rules`, `firestore.indexes.json`, `zipper-app/app/build.gradle.kts`, `firebase.json`,
   `.firebaserc`, `deploy-crm.command`. It refuses `f1af30a` (NOT production: it carries the unshipped Owner-MFA gate).
   Any new commit ⇒ regenerate it (after review) or every script refuses.
3. `tools/test-release-scripts-mac.command` — the stubbed local test (bash 3.2, network denied). Expect `N/N PASS`.

## Order at a glance

| Step | What | Script(s) | Word(s) | Rollback |
|---|---|---|---|---|
| 0 | SendGrid Phase C: controlled test e-mail + C3 | `~/zipper-release/sendgrid-email-20261030T204905Z/production/sg-C3-verify-readonly.command` | (read-only) | `sg-C9-rollback-functions-wave-a.command` ROLLBACK |
| 1 | Preflight | `00-preflight-readonly.command` | — | — |
| 2 | Hotfix-1 Firestore rules, then hotfix-1 Storage rules (P0 sign-up photos) | `hotfix/rules-20261101/run-hotfix1-rules-tests.command`, then `30-deploy-rules-hotfix1.command`, then `32-deploy-storage-hotfix1.command` | RELEASE, RELEASE | `39-rollback-rules.command <30-evidence>` ROLLBACK, `49-rollback-storage.command <32-evidence>` ROLLBACK |
| 3 | E1: backend grant on `ZIPPER_SENDGRID_API_KEY` | `10-grant-backend-sendgrid-secret.command` | GRANT | `E1-REVERT` (manual) |
| 4 | Backend: no-traffic deploy, smoke, canary | `11-…` → `12 10` → `13` → `12 50` → `13` → `12 100` | DEPLOY, EMAIL/SKIP, UNTAG; CANARY10/50/100 | `19-rollback-backend.command` ROLLBACK or `12 back` BACK |
| 5 | Functions wave 2a | `20-deploy-functions-wave2a.command` | DEPLOY2A | `29-rollback-functions.command 2a` ROLLBACK |
| 6 | CRM (MFA CRM) | `50-deploy-crm.command` (runs `deploy-crm.command`) | CRM, then DEPLOY | `H-CRM-ROLLBACK` (console) |
| 7 | Build + publish APK 20 | `./gradlew :app:assembleProd`, then `60-publish-apk.command` | PUBLISH | `61-withdraw-apk.command <60-evidence>` WITHDRAW |
| 8 | Functions wave 2b (needs APK 20) | `21-deploy-functions-wave2b.command` | DEPLOY2B | `29-rollback-functions.command 2b` ROLLBACK |
| 9 | RC2 rules + Storage IAM, with the MFA CRM | RC2 emulator run, `31 <results>`, `40`, `41` | RELEASE, GRANT, RELEASE | `49 <41-evidence>` ROLLBACK (+REVOKE), `39 <31-evidence>` ROLLBACK |
| 10 | Monitoring | `70-monitoring-setup.command` | MONITOR | `MONITOR-REMOVE` (manual) |
| 11 | Post-deploy verification | `90-postdeploy-verify-readonly.command [minutes]` | — | — |
| 12 | Reset (separate tooling) | `backend/scripts/reset/run-reset.command` | its own words | its backup |
| 13 | Credential rotation — FINAL phase | `release/rotation-prepared/` | per script | per script |

## Step 0 — SendGrid Phase C: controlled test e-mail, then C3
- **Precondition:** Phase C (8 e-mail functions with `ZIPPER_SENDGRID_API_KEY:1`) live since 30 Oct (CHANGE.md).
- **Do:** one sign-in-code e-mail to your own inbox through a flow you choose (PLAN.md D4). Check the original:
  From `ZIPPER Live <no-reply@zipperlive.org>`, SPF/DKIM/DMARC pass, no tracking links. Then run `sg-C3-verify-readonly.command`.
- **Verify:** C3 `RESULT: PASS`; "transactional mail sent" ≥ 1, failed 0. Record the result in CHANGE.md.
- **Rollback:** `sg-C9-rollback-functions-wave-a.command` (ROLLBACK) — the 8 functions go back to `SG_MAIL_KEY`.

## Step 1 — Preflight (read-only)
- `./00-preflight-readonly.command` → `RESULT: PASS`: traffic 100% on `zipper-api-00046-siw`; template `00047-9cj` differs
  only by the two Owner-MFA names; ≥ 100 functions; Functions grant present on `ZIPPER_SENDGRID_API_KEY`; live rules
  hashes shown; Hosting `ba740f4158292308` live; Android debug record shown. Re-run it whenever you want the state.

## Step 2 — Hotfix-1 Firestore rules, then hotfix-1 Storage rules (P0: profile photos at sign-up)
- **Precondition:** `hotfix/rules-20261101/run-hotfix1-rules-tests.command` → `HOTFIX1-RUN: PASS` (results folder newer than
  both texts; its `SUMMARY.txt` names both sha256 — 32 reads the `storage rules:` sha256 line).
- **Do:** `./30-deploy-rules-hotfix1.command` (RELEASE), then right after it `./32-deploy-storage-hotfix1.command` (RELEASE):
  `hotfix/rules-20261101/storage.rules` = the 20 Oct DEPLOYED Storage text + A-1 only (profile image cap 5 → 15 MB; APK 19
  uploads the uncompressed photo at sign-up, which the 5 MB cap refuses). Each saves the live text first. No IAM change
  (the hotfix Storage text makes no cross-service read; 40 belongs to step 9).
- **Verify:** `live firestore rules = firestore.rules (…)` and `live storage rules = storage.rules (3f5b61c7…)` PASS; one
  sign-up on APK 19 with a 5–15 MB gallery photo completes. No client dependency (APK 19 and 20).
- **Note:** at step 9, 41 replaces the hotfix Storage text with the RC2 `storage.rules` (which keeps A-1).
- **Rollback:** `./39-rollback-rules.command production/30-rules-hotfix1-<UTC>` (ROLLBACK);
  `./49-rollback-storage.command production/32-storage-hotfix1-<UTC>` (ROLLBACK — back to the 20 Oct Storage text; no IAM
  question, the role of 40 is not held yet).

## Step 3 — E1: backend runtime identity on `ZIPPER_SENDGRID_API_KEY`
- **Do:** `./10-grant-backend-sendgrid-secret.command` (GRANT). Per-secret binding, this secret only; no value read.
- **Verify:** PASS: backend + Functions bindings present, no other binding.
- **Rollback:** `E1-REVERT` in APPROVAL-COMMANDS.txt (separate approval; harmless to keep while unused).

## Step 4 — Backend: new revision at 0%, smoke, one e-mail, canary
- **Precondition:** steps 1 and 3 PASS; traffic exactly 100% on one revision; template = serving + 2 MFA names.
- **Do:** `./11-deploy-backend-no-traffic.command` — DEPLOY (new revision, 0%, tag `completion-<HEAD7>`, built from the
  committed `backend/` on the template + `SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1` + 3 SendGrid settings), EMAIL (one
  observer sign-in code from the tag URL; or SKIP with a reason), UNTAG.
- **Verify:** 11 PASS (health, Firestore health, MFA status 401, no ERROR logs, "Zipper API ready", SendGrid accepted, the
  delivery mailbox shows the message), `production/backend-revision.txt` written.
- **Canary:** `./12-canary-backend.command 10` (CANARY10) → `./13-canary-monitor-readonly.command 60` until
  `RESULT: CONTINUE` (≥ 200 requests on NEW) → `12 50` (CANARY50) → `13` CONTINUE → `12 100` (CANARY100).
  12 itself pins back to BASE if a step is not live within 120 s.
- **Rollback:** any `RESULT: STOP`, or at will: `./19-rollback-backend.command` (ROLLBACK) or `./12-canary-backend.command back` (BACK).
  After step 6 a backend rollback must go together with the CRM rollback (the new CRM calls routes BASE lacks).

## Step 5 — Functions wave 2a (no client dependency)
- **Functions:** releaseBeansForWeek, weeklyPayoutReportGenerator (Phase D of SendGrid), syncPublicProfile,
  backfillPublicProfiles, startMobileSession (+ WAVE_2A_MAIL / WAVE_2A_HYGIENE when those commits are on HEAD).
- **Precondition:** not within Sunday 16:29–21:00 UTC (refused); `functions/.env` equals what the functions run with.
- **Do:** `./20-deploy-functions-wave2a.command` (DEPLOY2A): fresh tree from HEAD, npm ci, tsc, every test, then deploy by name.
- **Verify:** SCOPE PASS (only these changed), all ACTIVE, same identity, env unchanged, weekly report has both secrets.
- **Rollback:** `./29-rollback-functions.command 2a` (ROLLBACK) — redeploys the wave from the production tree
  `prod-live-20261030` (RELEASE.txt BASE_COMMIT `4e21b7f…`: byte-exact production code); refuses a BASE_COMMIT of `f1af30a`.

## Step 6 — CRM (the MFA CRM)
- **Precondition:** the completion backend serves 100% (checked). `zipper-crm/.env.local` complete (deploy-crm checks names only).
- **Do:** `./50-deploy-crm.command` (CRM), then deploy-crm.command's own DEPLOY. Hosting only.
- **Verify:** 50 PASS, `production/crm-live.txt` written; sign in as an Owner (MFA step or the "MFA unavailable"
  notice), Observer TOTP, one money screen read-only.
- **Rollback:** `H-CRM-ROLLBACK` (console, to the version recorded as `previous=` — `ba740f4158292308`), together with 19 if
  the backend also goes back.

## Step 7 — Build and publish APK 20 (1.2.6)
- **Do on the Mac, at the release HEAD:** `cd zipper-app && ./gradlew :app:assembleProd`; install the arm64 prod APK on a
  phone that has APK 19 and run sign-in, a live room, a call and a gift (first R8 build).
- **Do:** `./60-publish-apk.command` (PUBLISH). It verifies both ABIs (com.zipper.app, versionCode 20, 1.2.6, not
  debuggable, `CN=Android Debug`, built after the HEAD commit), saves the current `appConfig/androidUpdate`, dry-runs
  `publish_apk.py`, then publishes to channel `debug` with `minSupportedVersionCode 20`.
- **Verify:** 60 PASS (record = 20/20, sha256 of each ABI = the verified APK); an APK 19 phone is offered 1.2.6 and
  installs it over the old install. From now on APK 19 sessions are refused at sign-in.
- **Rollback:** `./61-withdraw-apk.command production/60-publish-apk-<UTC>` (WITHDRAW) — refused while wave 2b is live.

## Step 8 — Functions wave 2b (needs APK 20 on the phones)
- **Functions:** generateAgoraToken, settleGift, startCall, acceptCall, tickCall, endCall, declineCall, sweepStaleCalls (MONEY).
- **Precondition:** APK 20 published with minSupportedVersionCode ≥ 20 (checked) and the fleet updated.
- **Do:** `./21-deploy-functions-wave2b.command` (DEPLOY2B). **Verify:** as step 5; one call and one lucky gift on APK 20.
- **Rollback:** `./29-rollback-functions.command 2b` (ROLLBACK; the production tree `prod-live-20261030`, as step 5) — do
  this BEFORE any withdraw of APK 20.

## Step 9 — RC2 Firestore rules + indexes, Storage IAM, RC2 Storage rules — together, with the MFA CRM live
- **Precondition:** backend 100% on the completion revision and `crm-live.txt` live (both checked by 31 and 41); the RC2
  emulator run on the Mac wrote `tests/results-rc2-<UTC>/` with `RESULT.txt = PASS`, newer than both rules files, and
  `SUMMARY.txt` naming both sha256.
- **Do, within minutes:** `./31-deploy-rules-rc2.command tests/results-rc2-<UTC>` (RELEASE) → `./40-storage-iam-grant.command`
  (GRANT) → `./41-deploy-storage-rules.command` (RELEASE; refuses unless the role is live). Then every Owner binds MFA in the CRM.
- **Verify:** both scripts' `live … rules = …` PASS; an Owner with a bound MFA session reads/uploads one CRM image and
  reaches the Owner screens; an Owner without one is refused; APK users unaffected.
- **Rollback:** `./49-rollback-storage.command production/41-storage-rules-<UTC>` (ROLLBACK — back to the hotfix-1 Storage
  text 32 released — then REVOKE or KEEP for the role) and `./39-rollback-rules.command production/31-rules-rc2-<UTC>`
  (ROLLBACK) + `H-CRM-ROLLBACK` if Owners are locked out.

## Step 10 — Monitoring
- **Do:** `./70-monitoring-setup.command` (type the alert address — never printed or saved — then MONITOR). Idempotent.
- **Creates if missing:** e-mail channel "ZIPPER release alerts"; uptime check `zipper-api-health` on
  `https://zipperlive.web.app/api/health` (5 min, body `"status":"ok"`); policies for the uptime check, zipper-api 5xx (log)
  and Functions ERROR (log). Needs the Cloud SDK alpha and beta components.
- **Verify:** 70 PASS; re-run says "nothing to create". **Rollback:** `MONITOR-REMOVE`.

## Step 11 — Post-deploy verification (read-only)
- `./90-postdeploy-verify-readonly.command 1440` now and again after 24 h: one table — traffic/tags/digest, every wave
  function ACTIVE at the version 20/21 recorded, secret grants, Storage agent role, live rules sha256 = RELEASE.txt, Hosting
  = crm-live.txt, Android 20/20, monitoring objects, and log counts (errors, 5xx, mail accepted/failed, replica_drift).
- **Pass:** `RESULT: PASS` (no FAIL row). REVIEW rows are non-zero error counts to read in Logs Explorer.

## Step 12 — Reset (only after acceptance AND a verified backup)
- `backend/scripts/reset/run-reset.command` (its own RESET-RUNBOOK.md, typed targets and words: backup → verify → plan →
  rehearse → execute → seed → postcheck). Not part of this folder; never before the release is accepted.

## Step 13 — Credential rotation — FINAL phase
- `release/rotation-prepared/ROTATION-RUNBOOK.md`. Nothing there runs until you create
  `release/rotation-prepared/FINAL-PHASE-APPROVED`. SendGrid first (v1 was exposed), then Agora, service keys, JWT, Mongo.

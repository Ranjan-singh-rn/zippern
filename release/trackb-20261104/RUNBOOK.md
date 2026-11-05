# ZIPPER Track B release 20261104 — production runbook (prepared, NOT executed)

Deploys everything built since the completion release (cf64145): the backend, the CRM, Functions, Firestore rules and
indexes, the RC2 Storage rules, and APK 21 (1.2.7) to the "debug" channel of the in-app updater, for the stakeholders
to test. Every step that changes production needs **its own explicit approval** (the `STEP-n` line in
`APPROVAL-COMMANDS.txt`) and **the typed word** the script asks for. Nothing in this folder has been run against production.

**Updated 5 Nov 2026 — the Owner's list is in this release too** (commits e18f7b6, 7a8512a, 0a0ad4e on top of
e6ce378): live calls switch (O1), Lottie gifts in rooms (O2), the seller business in the Work tab (O3), Messages —
photos, voice notes, gifts, block/report, delete (O5), the chat call button and currency glyphs (O5b), Call from a
live room and from party members (O5c), one Owner's approval is final on the money board (O6), sellers pay back
borrowed coins (O7), decorations everywhere with a Store (O9), the speed pass (O10) and the Home order with officials
hidden (O11). `functions/src/push.ts` changed (the chat push names voice notes and gifts), so its four triggers moved
from NOT_REDEPLOYED to wave A: wave A is now **144** (85 changed + 59 new — O12 adds monitorRoomToken and myMonitorRooms; O13 adds reportLiveSnapshot and the three chat-screen triggers), NOT_REDEPLOYED 9. New rules: O1's
`hostBlocksCalls` host field, O5's chat message create/update/delete and `chatMedia/` in Storage — the rules emulator
run below must be repeated at this HEAD.

**Where:** `~/Documents/Projects/zippern/release/trackb-20261104/`. Run each script from Terminal in that folder
(`./NN-name.command`, or double-click). Project `zipper-83816`, region `asia-south1`.

**What production runs today (4 Nov 2026)** — the completion release, steps 0–6:
backend `zipper-api-00057-xiq` at 100% (also the service template); Functions: the completion wave 2a (95) from
cf64145, the 8 call/gift functions and `onHostInvitationWithdrawn` from prod-live-20261030 (20 Oct); CRM Hosting
`bf4066501e5f593a`; hotfix-1 Firestore + Storage rules and the 1 Nov indexes; APK 19 on the phones (APK 20 was never
published). The completion release's steps 7–11 are **superseded** by this release (APK 21 instead of 20, the rules
carry RC2 + Track B). Its folder and evidence stay as they are.

**How the scripts protect themselves** (unchanged from the completion release)
- Each refuses to run unless every file listed in `SCRIPTS.sha256` is unchanged (exit 2).
- Each refuses a dirty working tree, and a HEAD or any recorded tree/file hash that differs from `RELEASE.txt`
  (exit 3). Only committed code is deployed.
- Each production change sits on one line tagged `#MUT-…`, behind a typed word (anything else: exit 4, nothing changed).
- Evidence: `production/<id>-<UTC>/SUMMARY.txt` (+ `stderr.log`, which may name the operator account — do not share).
  No secret, environment value or person's address is printed or saved.
- Not in this folder: 10 (SendGrid grant — done 1 Nov), 30 and 32 (hotfix-1 rules — live since 1 Nov; re-running them
  after 31/41 would roll the rules back).

**Rules for every step**
- Never `--to-latest`; traffic moves by revision NAME only. Never route traffic to `zipper-api-00048-pit`.
- Never delete `zipper-api-00046-siw`, `zipper-api-00047-9cj` or `zipper-api-00057-xiq` (this release's BASE).
- Never print, paste or `versions access` a secret. Never `firebase deploy` from the working tree by hand.

## One-time setup (local, no approval needed except the commit)
1. **Function lists.** After the last change under `functions/src`:
   `python3 -I tools/check-function-lists.py` → `RESULT: ok`. A `DANGER` line means `rel_common.sh` must change
   (then `tools/write-scripts-sha256.command`).
2. **Rules emulator run.** Stop the local test copy (Ctrl-C in its window: the run needs ports 8080, 9199 and 8085),
   then `bash tools/run-trackb-rules-tests.command` → `TRACKB-RULES-RUN: PASS`, results in
   `rules-results/results-<UTC>/` (git-ignored). It runs the 16 RC2 suites and the Track B live suite (b12live).
3. **Stubbed script test (bash 3.2).** `bash tools/test-release-scripts-mac.command` → `N/N PASS` (network denied).
4. **Commit** the release — code + this folder (with `SCRIPTS.sha256`) — Owner approval. No push.
5. `./make-release-txt.sh` (no argument) — writes the git-ignored `RELEASE.txt`: HEAD, BASE_COMMIT
   (refs/heads/prod-live-20261030 = 4e21b7f…), LIVE_FN_COMMIT (cf64145…, must be an ancestor of HEAD) and the tree
   hashes. Any new commit ⇒ run it again (or every script refuses).

## Order at a glance

| Step | What | Script(s) | Word(s) | Rollback |
|---|---|---|---|---|
| 1 | Preflight | `00-preflight-readonly.command` | — | — |
| 2 | Backend: new revision at 0%, smoke, one e-mail, canary | `11-…` → `12 10` → `13` → `12 50` → `13` → `12 100` | DEPLOY, EMAIL/SKIP, UNTAG; CANARY10/50/100 | `19-rollback-backend.command` ROLLBACK or `12 back` BACK |
| 3 | Functions wave A (144: 85 changed + 59 new) | `20-deploy-functions-wave2a.command` | DEPLOY2A | `29-rollback-functions.command 2a [<20-evidence>]` ROLLBACK |
| 4 | CRM | `50-deploy-crm.command` (runs `deploy-crm.command`) | CRM, then DEPLOY | `H-CRM-ROLLBACK` (console, to bf4066501e5f593a) |
| 5 | Firestore indexes (until READY) | `33-deploy-indexes.command` | INDEXES | none (additive) |
| 6 | Build + publish APK 21 (1.2.7) | `./gradlew :app:assembleProd`, device smoke, `60-publish-apk.command` | PUBLISH | `61-withdraw-apk.command <60-evidence>` WITHDRAW |
| 7 | Rules (RC2 + Track B) + Storage IAM + RC2 Storage rules, within minutes | `31 <rules-results/…>`, `40`, `41` | RELEASE, GRANT, RELEASE | `39 <31-evidence>` ROLLBACK, `49 <41-evidence>` ROLLBACK (+REVOKE/KEEP) |
| 8 | Functions wave B (10) — after the phones run APK 21 | `21-deploy-functions-wave2b.command` | DEPLOY2B | `29-rollback-functions.command 2b [<21-evidence>]` ROLLBACK |
| 9 | Monitoring | `70-monitoring-setup.command` | MONITOR | `MONITOR-REMOVE` (manual) |
| 10 | Post-deploy verification | `90-postdeploy-verify-readonly.command [minutes]` | — | — |
| — | Owner MFA enforcement — **not part of this release** (a separate Owner decision) | `45`, `46` | ENFORCE-NEW, ENFORCE | `47` ROLLBACK |

**Why this order.** Everything an APK 19 phone uses keeps working until step 6: wave A changes nothing an old app
sends (its new refusals are messages the app shows), and the 59 new functions are never called by old apps. Step 6
forces the update (minSupportedVersionCode 21). The rules (7) come right after it: they refuse APK 19's own PK
writes (the client created `pkInvites` and wrote both rooms' `pkActive`/`pkScore`) and APK 21 needs them for
leaderboards, Party Pro status, music and game history reads. Wave B (8) needs APK 21 on the phones: the new
`generateAgoraToken` signs for a derived uid (APK 19 joins with uid 0), the new `settleGift` refuses a lucky gift
without a combo, per-minute call billing goes with the APK 21 call screen, and the new `joinPartyRoom` +
`sweepEmptyPartyRooms` drop a listener 3 minutes after its last heartbeat (APK 19 sends none).

## Step 1 — Preflight (read-only)
`./00-preflight-readonly.command` → `RESULT: PASS`: traffic 100% on `zipper-api-00057-xiq`, which is also the latest
created revision (the template) with the same environment names and `OWNER_MFA_ENCRYPTION_KEY:1`; ≥ 100 functions;
secret grants; live rules hashes (hotfix-1 texts); Hosting `bf4066501e5f593a`; the Android record (19).

## Step 2 — Backend
- **Do:** `./11-deploy-backend-no-traffic.command` — DEPLOY (new revision at 0%, tag `trackb-<HEAD7>`, built from the
  committed `backend/` on the template 00057-xiq; the SendGrid settings it re-states are already there), EMAIL (one
  observer sign-in code from the tag URL; or SKIP with a reason), UNTAG. Track B adds no required backend setting
  (every new `app/config.py` setting has a default). At start-up the revision runs `ensure_indexes()` on MongoDB.
- **Verify:** 11 PASS, `production/backend-revision.txt` (NEW, BASE = 00057-xiq).
- **Canary:** `./12-canary-backend.command 10` → `./13-canary-monitor-readonly.command 60` until `RESULT: CONTINUE`
  → `12 50` → `13` CONTINUE → `12 100`.
- **Rollback:** `./19-rollback-backend.command` (ROLLBACK) or `./12-canary-backend.command back` (BACK). After step 4 a
  backend rollback goes together with the CRM rollback (the new CRM calls routes 00057-xiq does not have).

## Step 3 — Functions wave A (144)
- **Do:** `./20-deploy-functions-wave2a.command` (DEPLOY2A). Not within Sunday 16:29–21:00 UTC (refused). Fresh tree
  from HEAD, npm ci, tsc, every test; the exports of the built `lib/index.js` must be exactly WAVE_2A + WAVE_2B +
  NOT_REDEPLOYED in their regions, and every deployed name must have one rollback base; then deploy by name.
- **Verify:** SCOPE PASS (`changed=144`; the 59 new ones appear), all ACTIVE, identities, env unchanged, the weekly
  report and the 8 e-mail functions keep `ZIPPER_SENDGRID_API_KEY`.
- **Write quota:** as in the completion release — on `SCOPE PARTIAL` re-run 20, or roll back exactly `updated.txt`.
- **Rollback:** `./29-rollback-functions.command 2a [production/20-functions-2a-<UTC>]` (ROLLBACK, typed once): the
  85 changed functions go back to the cf64145 tree (what they ran before); the 59 new ones are **left deployed** (no
  older code exists; old apps never call them; nothing here deletes a function).

## Step 4 — CRM
- **Do:** `./50-deploy-crm.command` (CRM), then DEPLOY inside `deploy-crm.command` (npm ci, typecheck, tests, build,
  verify:out, `firebase deploy --only hosting:production`). Needs step 2 at 100%.
- **Verify:** 50 PASS, `production/crm-live.txt`; sign in as an Owner (MFA), the Observer, one money screen read-only;
  Owner-only: App Config → Games (every game OFF), Party Pro, Leaderboards.
- **Rollback:** console → Hosting → zipperlive → Release history → `bf4066501e5f593a` → Rollback (H-CRM-ROLLBACK).

## Step 5 — Firestore indexes
- **Do:** `./33-deploy-indexes.command` (INDEXES). Refused unless the file is a superset of the live indexes (nothing
  is ever deleted). Re-run until every index is READY — before step 6 and step 7.

## Step 6 — APK 21 (1.2.7) to the stakeholders
- **Do on the Mac, at the release HEAD:** `cd zipper-app && ./gradlew :app:assembleProd`; install the arm64 prod APK on
  one phone that has APK 19 and run sign-in, a live room, a party room with a gift, a call (first R8 build of Track B).
- **Do:** `./60-publish-apk.command` (PUBLISH): verifies both ABIs (com.zipper.app, versionCode 21, 1.2.7, not
  debuggable, built after HEAD, `apksigner verify` exit 0, exactly one certificate = FLEET_CERT_SHA256), saves the
  current `appConfig/androidUpdate`, dry-runs, then publishes to channel `debug` with minSupportedVersionCode 21.
  Stakeholders' phones are offered 1.2.7 at once; APK 19/20 sessions are refused at sign-in from then on.
- **Rollback:** `./61-withdraw-apk.command production/60-publish-apk-<UTC>` (WITHDRAW) — refused while wave B is live.

## Step 7 — Rules, Storage IAM, Storage rules (within minutes, right after step 6)
- **Precondition:** the rules emulator run of the one-time setup (`rules-results/results-<UTC>/RESULT.txt = PASS`,
  newer than both rules files, naming both sha256, with a passing `b12live` line); backend 100% (step 2); CRM live
  (step 4); indexes READY (step 5).
- **Do:** `./31-deploy-rules-rc2.command rules-results/results-<UTC>` (RELEASE) → `./40-storage-iam-grant.command`
  (GRANT) → `./41-deploy-storage-rules.command` (RELEASE; refuses unless the role is live). Each rules script saves
  the live text (hotfix-1) first.
- **Verify:** both `live … rules = …` PASS; an Owner with a bound MFA session reads/uploads one CRM image.
- **SVGA uploads:** `storage.rules` admits a name ending in `.svga` as application/octet-stream (at most 5 MB) under
  `contentAssets/` — the gift editor's and bag-items page's SVGA slots store files (fixed before this release).
- **Rollback:** `./39-rollback-rules.command production/31-rules-rc2-<UTC>` (ROLLBACK);
  `./49-rollback-storage.command production/41-storage-rules-<UTC>` (ROLLBACK, then REVOKE or KEEP).

## Step 8 — Functions wave B (10)
- **Precondition:** APK 21 published with minSupportedVersionCode ≥ 21 (checked) and the stakeholders' phones updated.
- **Do:** `./21-deploy-functions-wave2b.command` (DEPLOY2B): generateAgoraToken settleGift startCall acceptCall
  tickCall endCall declineCall sweepStaleCalls (MONEY) + joinPartyRoom sweepEmptyPartyRooms.
- **Verify:** as step 3 (`changed=10`); one call on APK 21 (first minute charged at connect); one party-room gift to a
  chosen seat; a listener stays in a party room > 5 minutes. Lucky gifts stay **off**; every game stays **off** until
  the Owner switches it on in the CRM.
- **Rollback:** `./29-rollback-functions.command 2b [production/21-functions-2b-<UTC>]` (ROLLBACK, typed once): the 8
  call/gift functions go back to the 20 Oct tree, joinPartyRoom + sweepEmptyPartyRooms to cf64145 — BEFORE any 61.

## Step 9 — Monitoring
`./70-monitoring-setup.command` — type the alert address (never saved), then MONITOR. Idempotent.

## Step 10 — Post-deploy verification
`./90-postdeploy-verify-readonly.command 1440` now and after 24 h → every row PASS (Owner MFA enforcement is an INFO
row: not part of this release).

## After the stakeholders' sign-off (a separate approval, not part of this release)
1. **Reset.** The Owner runs `backend/scripts/reset/run-reset.command` himself (read `RESET-RUNBOOK.md` first):
   backup → verify → plan → the Owner reviews the manifest → rehearse → execute → seed → postcheck, each with its own
   typed word. It deletes every user's data in Firestore, Auth, Storage and MongoDB (the Owner and Observer logins
   included). Nobody else runs it; no script in this folder deletes data.
2. **Owner and Observer accounts.** The reset's `seed` step creates exactly one Observer and up to three Owners from
   `backend/scripts/reset/seed-accounts.json` (copy `seed-accounts.example.json`, fill in the Owner's real names,
   emails and E.164 phones; never committed). The deployed `OBSERVER_EMAIL` must equal the Observer's address. Owners
   enrol MFA at the first CRM login; the Observer signs in at `/observer` with the e-mailed code.
3. **Public release.** Then a release build for everyone (a new APK version on the "release" channel — not prepared here).

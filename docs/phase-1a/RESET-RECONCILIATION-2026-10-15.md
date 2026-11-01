# Test-data reset reconciliation: what was deleted, where, and by whom

Prepared 2026-10-15. **This was an investigation only.** No reset script was run, no production service was contacted, nothing was deleted, and nothing was restored.

Every finding comes from three sources:
- the local code and configuration files;
- the reset log files in `backend/`;
- the Terminal output you pasted into this conversation on 2026-10-07 and 2026-10-13.

---

## 1. Verdict

**Production impact: CONFIRMED.**

On **2026-10-07 and 2026-10-08**, `scripts.execute_test_data_reset --apply` ran **eight times**. Seven runs deleted data and one deleted nothing. Together they permanently deleted **1,620 records** from the live system:

| Service | Target | Deleted |
|---|---|---|
| Firebase Auth | project `zipper-83816` | 28 accounts |
| Firestore | project `zipper-83816` | 525 top-level documents¹, plus 2 Owner `users` documents **reset** (balance fields set to 0) |
| Cloud Storage | bucket `zipper-83816.firebasestorage.app` | 62 objects |
| MongoDB | database `zipper` on Atlas cluster `zipper.m865dly.mongodb.net`, the database the deployed API writes to (§4) | 1,005 records, including **180 audit-log entries**, 738 email-delivery records and the money-history rows (`--fresh` policy) |

¹ The executor removes each Firestore document with `recursive_delete`, which also deletes any nested sub-collections. Those nested documents are not counted anywhere, so 525 is a minimum.

**Who did what**

| Who | What | Evidence |
|---|---|---|
| **You, on your Mac** | Ran all eight executions from `~/Documents/Projects/zippern/backend` | Runs 1–3 and 6–8 appear in your Terminal output. Runs 4 and 5 appear in no pasted output, but their logs are in `backend/`, and no command Claude ran invoked the executor (last row). |
| **Claude** | Built and changed the planner and executor in earlier parts of this conversation | The conversation's earlier summary lists both scripts among Claude's work |
| **Claude** | Edited both again on 2026-10-07 at 20:37 UTC, before runs 3–8 | — |
| **Claude** | Edited the planner on 2026-10-07 at 21:28 UTC and on 2026-10-08 at 21:13–21:15 UTC, to classify new collections | — |
| **Claude** | Gave you the commands each time | — |
| **Claude** | Did **not** run the planner, the executor, the backup script or any delete helper against live services | Every shell command Claude ran from 2026-10-07 20:37 UTC onward was checked; there were 428 when checked. The ones that touched the reset scripts ran the planner's unit tests (in-memory fakes) or imported the planner to read its collection lists. Runs 1 and 2 happened before this conversation record starts, but they are in your own Terminal output. |

What you asked for:
- 2026-10-07: "except owner and observer delete every account and those related data".
- 2026-10-08, 21:12 UTC: "except owner and observer. rest every user and their details please".

**Backups.** None exist for any deleted data.

| When (UTC) | Event |
|---|---|
| 2026-10-07 20:33 and 20:43 | You took two local Firestore backups, as part of the reset procedure Claude had given you |
| 2026-10-07 21:22 | You wrote "please delete dont take backup", and Claude told you to skip the backup step |
| 2026-10-07 21:26:39 | At your request ("previously we took backup . delete those backups"), **Claude deleted both backups** (`rm -rf firestore-2026-10-07-2033 firestore-2026-10-07-2043`) |

The remaining backups are from August and predate the deleted data. Those backups were Firestore-only. Restoration was not attempted, and it is not possible from local backups.

**The Phase 1A report's statement "No production data was read or written" was misleading as written.** It is true only of Claude's own actions during Phase 1A, from 2026-10-14 onward. See §7.

## 2. How the scripts choose their targets (code)

Both scripts take every target from `app.config.settings` and `app.db`. No target is a command-line option, and no log records which project, bucket or database was touched.

| Target | Code | Resolved from |
|---|---|---|
| Settings | `backend/app/config.py`: `SettingsConfigDict(env_file=".env")` | `.env` **in the current directory**; environment variables override it |
| Firebase Auth and Firestore | `app/db/firebase.py::init()` uses `credentials.Certificate(settings.firebase_credentials_path)` if the file exists, otherwise Application Default Credentials. No `projectId` option is set, so **the project comes from the credential file**. `settings.firebase_project_id` is not used. | `FIREBASE_CREDENTIALS_PATH`, default `../serviceAccountKey.json` |
| Storage bucket | `init()` sets `storageBucket = settings.firebase_storage_bucket` | `FIREBASE_STORAGE_BUCKET`; code default **`zipper-83816.firebasestorage.app`** |
| MongoDB | `app/db/mongo.py::connect()` calls `AsyncIOMotorClient(settings.mongo_uri)`; the database is `settings.mongo_db` | `MONGO_URI`, `MONGO_DB` |
| Executor | `execute()` re-plans live and asks you to type `DELETE <n>`. It then re-reads live data phase by phase (Mongo → Firestore → Storage → Auth) and deletes whatever classifies as DELETE **at that moment** | — |

The target-selection code is identical in commit `1194e55` (2026-10-04 22:13 UTC) and in today's working tree. The later changes to these three files only add functions unrelated to target selection, so the same code was in effect on 2026-10-07/08.

The docstrings call these production tools:
- planner: "DRY-RUN plan for the production test-data reset";
- executor: "Execute the FRESH production reset".

## 3. Configuration in effect during the runs

This was established from file contents and modification times, **not** from the working directory alone. The working directory shown in your prompts (`… backend %`) only determines which `.env` file is loaded.

| File | Last modified (UTC) | Relevant values (no secrets) |
|---|---|---|
| `backend/.env` | 2026-08-24 13:45, before every run | `ENVIRONMENT=development` (a label only); `FIREBASE_CREDENTIALS_PATH=../serviceAccountKey.json`; `FIREBASE_PROJECT_ID=zipper-83816`; `FIREBASE_STORAGE_BUCKET` not set; `MONGO_DB=zipper`; `MONGO_URI` host `zipper.m865dly.mongodb.net` |
| `serviceAccountKey.json` (repo root) | 2026-08-21 21:47, before every run | `type: service_account`, **`project_id: zipper-83816`**, identity domain `zipper-83816.iam.gserviceaccount.com`. The private key was not read out. |
| `zipper-app/app/google-services.json` | 2026-09-07 | Project `zipper-83816`, bucket `zipper-83816.firebasestorage.app`, the same as the app in users' hands |

`deploy.sh` gives the deployed API `MONGO_DB=zipper` and reads `MONGO_URI` from Secret Manager. That secret was **not** read, because reading it means contacting production.

**Not verifiable:** whether your shell had other variables exported at the time; exported variables override `.env`. The pasted output shows only `JAVA_HOME` and `PATH` being set. This gap does not weaken the content evidence in §4.

## 4. Evidence that the targets were the live production system

1. **The production Owners and Observer.** The planner refuses to run unless all of these hold:
   - Mongo `staff` holds exactly 3 `role=owner` rows, whose uids match the 3 uids you typed;
   - each Owner uid is a live Firebase Auth account;
   - exactly one Observer row exists, with email `314zipper@gmail.com` and **no** Auth account.

   Every run passed these checks with the same allowlist fingerprint, `eca06bdfbb9a1bef`. The Observer's staff row is `6a8718c6ab86ecd513828c87`.
2. **The production content.** The preserved set includes:
   - `storage/appBuilds/`: 55 objects, the in-app updater's APKs;
   - `storage/contentAssets/`: 50 objects;
   - Firestore `appConfig` 5, `gifts` 10, `bagItems` 34, `rechargePackages` 7, `diamondPacks` 6, `paymentConfig` 1.
3. **The deployed scheduler was writing into the same Mongo database during the 2026-10-08 session.** Two schedules call the deployed Cloud Run API: a 15-minute sweep and a 30-minute alert scan (`functions/src/index.ts`). Each job writes one row to `scheduled_runs` when it finishes (`app/services/scheduling.py`). The local backend has no scheduler of its own (`app/main.py`).

   | Point in the session (UTC) | `scheduled_runs` |
   |---|---|
   | Plan, re-plan and post-check around run 6 (≈21:41–21:43) | 1,025 |
   | Plan for run 7 (≈21:50), the plan for run 8 (21:59, `reset-plan.json`) and run 8's own re-plan (≈22:01) | 1,026 |
   | Post-check after run 8 (22:02, `reset-postcheck.json`) | 1,028 |

   This matches the deployed schedule:
   - +1 across 21:45, when only the 15-minute sweep fires;
   - no change from 21:52 to 21:59, when nothing is scheduled;
   - +2 after 22:00, when both schedules fire.
4. **The live app was writing to the same Firestore and Auth.** New `authEvents`, `quickLoginTokens`, partner records and Auth accounts kept appearing between runs. For example, 47 deletable records appeared between the post-check after run 7 and the plan for run 8, about 7 minutes apart.
5. **There is no other environment.** `.firebaserc` names only `zipper-83816`, and no staging project exists.

## 5. Every recorded `--apply` execution

For each run, the table shows the total the executor asked you to confirm and the number it actually deleted.

The time window comes from the log:
- its `started` value is written **after** you typed the confirmation;
- so the window runs from your confirmation to the finish, not from when the executor was launched.

| # | Deletion window (UTC) | Confirmed | Deleted | Mongo | Firestore | Storage | Auth | Log in `backend/` | Recorded in |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-10-07, between 06:27 and 12:58² | **767** | **767**, plus 2 Owner resets | 608 | 132 | 15 | 12 | `reset-plan-applied.json`, **overwritten by run 2** | Your 2026-10-07 Terminal output only |
| 2 | 2026-10-07 12:58:22 → 12:59:03 | 0 | 0 | 0 | 0 | 0 | 0 | `reset-plan-applied.json` | 2026-10-07 output + log |
| 3 | 2026-10-07 20:45:40 → 20:46:25 | 121 | 120 | 78 | 27 | 12 | 3 | `reset-plan-applied-20261007T204625Z.json` | 2026-10-07 output + log |
| 4 | 2026-10-07 21:30:46 → 21:31:32 | not pasted (last pasted plan: 44) | 49 | 21 | 25 | 0 | 3 | `reset-plan-applied-20261007T213132Z.json` | Log only |
| 5 | 2026-10-08 21:21:58 → 21:22:58 | not pasted (last pasted plan: 428) | 428 | 263 | 139 | 21 | 5 | `reset-plan-applied-20261008T212258Z.json` | Log only |
| 6 | 2026-10-08 21:41:40 → 21:42:37 | 107 | 106 | 16 | 85 | 4 | 1 | `reset-plan-applied-20261008T214237Z.json` | 2026-10-13 output + log |
| 7 | 2026-10-08 21:50:39 → 21:51:27 | **34** | **72** | 10 | 55 | 5 | 2 | `reset-plan-applied-20261008T215127Z.json` | 2026-10-13 output + log |
| 8 | 2026-10-08 22:01:00 → 22:02:00 | **55** | **78** | 9 | 62 | 5 | 2 | `reset-plan-applied-20261008T220200Z.json` | 2026-10-13 output + log |
| | **Total** | | **1,620** | **1,005** | **525** | **62** | **28** | | |

² Run 1 came after the Terminal session's "Last login" time (11:57 IST, 06:27 UTC) and before run 2. Its per-collection counts are known only from the executor's printed output. The two Owner resets set `beans`, `diamonds`, `hostGiftEarnings` and `totalGiftsReceived` to 0 on `users/KVGm…` and `users/q3ht…`. Runs 2–8 reset nothing.

Deletions by collection, all runs:

| Store | Deleted |
|---|---|
| Mongo (1,005) | `email_deliveries` 738 · `audit` 180 · `reconciliation` 22 · `sessions` 18 · `partners` 16 · `partner_role_claims` 10 · `weekly_business_reports` 7 · `staff` 6 · `cards` 3 · `balances` 2 · `ledger` 2 · `recharges` 1 |
| Firestore (525) | `authEvents` 227 · `quickLoginTokens` 105 · `notifications` 30 · `users` 27 · `publicProfiles` 27 · `quickLoginChallenges` 25 · `crmUsers` 17 · `verifiedIdentities` 15 · `agencies` 9 · `conversations` 7 · `platformRevenue` 7 · `sellers` 7 · `guestDeviceBindings` 6 · `appeals` 5 · `coinPurchaseRequests` 2 · `hostApplications` 2 · `quickLoginRate` 2 · `hostVerification` 1 · `liveRooms` 1 · `publicSellers` 1 · `rechargeRequests` 1 · `weeklyPayoutReports` 1 |
| Storage (62) | Runs 3–8: `kyc/` 26 · `sellerDocs/` 13 · `appealEvidence/` 4 · `coinPurchaseProofs/` 2 · `hostVerification/` 1 · `rechargeProofs/` 1 (47 in all). Run 1: 15 objects, folders not printed. |
| Auth (28) | Every Auth account other than the 3 Owners at the moment of each run (the Observer has no Auth account by design) |

Other files:
- `backend/reset-plan.json` is the last plan, written 2026-10-08 at 21:59 UTC. Earlier plans were overwritten.
- `backend/reset-postcheck.json` was written at 22:02 UTC.

## 6. Weaknesses in the reset tooling (not fixed; outside this task's scope)

1. **The confirmation does not limit the deletion.** You confirm a count taken from a re-plan. The executor then re-reads every collection and deletes whatever qualifies at that moment.
   - Run 7 deleted **72 instead of 34**, and run 8 deleted **78 instead of 55**.
   - Some of the extra records were of kinds absent from the plan you confirmed: in run 7, an `agencies` document and 3 `kyc/` files; in run 8, a `sellers` document and 2 `sellerDocs/` files.
   - Nothing preserved was touched: the PRESERVE and RESET totals are the same before and after every run, apart from `scheduled_runs` growing.
   - Most likely the extra records were created by live app use between the re-plan and the deletion. The logs cannot show when each was created.
2. **The first executor used a fixed log name.** The 767-record log was overwritten by run 2; only your Terminal output preserves it. Later versions use timestamped names.
3. **The logs record no target.** They name no project, bucket or database.
4. **Firestore sub-collection deletions are not counted** (note 1 in §1).
5. **There is no environment guard.** The tools act on whatever `.env` and the credential file point to, with no allowlisted project and no confirmation naming the target.
6. **`--fresh` deletes audit and money history.** The audit log is meant to be append-only (CRM-FLOW Part 6) unless this was an accepted one-off decision for pre-launch test data.

## 7. Corrections to earlier statements

| Earlier statement (Phase 1A report, revision 3) | Correction |
|---|---|
| "No production data was read or written." | True only of Claude's actions **during Phase 1A** (from 2026-10-14). Before Phase 1A, on 2026-10-07/08, production data was deleted by the runs in §5. You executed them using tooling and commands from Claude, and Claude deleted the two backups at your request. |
| "Nothing was … installed." | Wrong. The first validation runner, written by Claude and run by you on 2026-10-14 at 23:51 and 23:52 UTC, did three things it should not have: <br>• ran `npm install` in `tests/`, with its output hidden; this rewrote `tests/package-lock.json` at 23:52:31 UTC; <br>• ran `./gradlew --version`, which downloaded the Gradle 8.14.5 distribution; <br>• ran `adb devices -l`, which started the adb server. |
| §2 runner: "What it never does: … install" | Wrong for that version, for the same reasons. Revision 2 of the runner (2026-10-15) removes all three and installs nothing. |

**Files missing from the repository.** These three files that Claude created on 2026-10-14 are no longer on disk:
- `docs/phase-1a/ZIPPER-Phase1A-Report-2026-10-14.md`
- `docs/phase-1a/STAGING-VALIDATION-PLAN.md`
- the first `tests/run-phase1a-validation.sh`

No command Claude ran removed them. Finder last updated those two folders on 2026-10-15 at 00:01 UTC, right after your validation run ended. The cause is unknown.

What was and was not done:
- The runner was rewritten as revision 2, because this task asked for a safe runner.
- The report and staging plan were **not** recreated, so that a deliberate removal is not undone.
- The corrected report (revision 4) is in Claude's outputs folder. When the staging plan is restored, its APK note must say: rebuilt 2026-10-15 00:00:33 UTC from Phase 1A code by your validation run; still a production-targeting debug build.

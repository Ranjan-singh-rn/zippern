# ZIPPER reset runbook — backup → verify → plan → execute → seed → postcheck

Spec §14. Tooling: `backend/scripts/reset/`. Launcher: `run-reset.command` (double-click on the Mac, or
`bash backend/scripts/reset/run-reset.command`). Tests: `cd backend && python3 -B -m tests.test_reset_tooling`.

The old `scripts/plan_test_data_reset.py` and `scripts/execute_test_data_reset.py` are superseded and refuse `--apply`.
Nothing in this folder reads `backend/.env`, `.firebaserc` or a default bucket: **every target is typed**.

## What the reset does (Owner decision of 2026-10)

Deletes, per id from a frozen manifest: every app account and its subcollections, every partner, every CRM login
**including the current Owner and Observer logins**, all money history / ledgers / balances / recharges / cards,
every ticket and appeal, the three uploads prefixes `profileMedia/`, `kyc/`, `hostVerification/`, every Firebase Auth
account, the Mongo ledgers and audit data. Keeps: `appConfig` (economy, androidUpdate, …), gifts, bag items, levels,
packages, policies, announcements, `appBuilds/`, `contentAssets/`, versioned rates, chance tables, the data canary,
the scheduler's run log, alert suppression keys. Hosting is never touched. The full table with a reason per name is
`classification.py`; anything not in it makes `plan` refuse.

Afterwards `seed.py` creates the Observer and the Owners **only from `seed-accounts.json`** (the Owner's exact list;
not in git). Owners re-enrol MFA on first login. The deployed `OBSERVER_EMAIL` must equal the Observer's address.

## Before the day

1. **Decide the undecided Storage prefixes.** `classification.STORAGE_UNDECIDED` lists personal/partner file prefixes
   the spec did not approve for deletion (sellerDocs, appealEvidence, coinPurchaseProofs, rechargeProofs, …). If any
   object exists under one, `plan` refuses until the Owner moves the prefix to `STORAGE_DELETE` or `STORAGE_KEEP`.
   Commit that edit; the table's fingerprint is recorded in the manifest and checked by `execute`.
2. **Data canary (step 0).** `execute`, `plan` and `seed` refuse unless MongoDB holds
   `ops_canary/target` with `firebase_project_id` = the project id (the P0-10 convention of
   `app/core/destructive.py`). If it is absent, a person provisions it deliberately, once:
   ```
   mongosh "<connection string>" --eval 'db.getSiblingDB("<db>").ops_canary.updateOne({_id:"target"},{$set:{firebase_project_id:"<project id>",provisioned_by:"<name>",provisioned_at:new Date()}},{upsert:true})'
   ```
3. **`seed-accounts.json`.** Copy `seed-accounts.example.json` to `seed-accounts.json` in this folder and fill in the
   Owner-provided names, emails and E.164 phones. Exactly one observer, up to three owners. Placeholder addresses are
   refused. The launcher validates it before anything destructive runs.
4. **Tooling on the Mac.** `backend/.venv` (python 3.12, firebase-admin, google-cloud-storage, pymongo), `gcloud`
   (authenticated, with `datastore.databases.export` permission on the project), `gsutil`, `mongodump`
   (and `mongorestore` if available — `verify` runs `--dryRun` with it, else lists the archive).
   The service-account key for the project (its `project_id` is compared with what you type).
5. **Export the Mongo connection string into the shell**, under a NAME you will type (never the value):
   `export MONGO_URI_RESET='mongodb+srv://…'`. It reaches `mongodump` through a 0600 temp config file and is never printed.
6. **Quiet hour.** The app and the API stay live; whatever is created after the plan's `manifest_time` survives by
   design (see "freeze"). Pick a quiet window and, if possible, announce downtime.
7. Run the tests: `cd backend && python3 -B -m tests.test_reset_tooling` must pass.

## The run (what the launcher does, step by step)

Each step is a separate typed confirmation (type the step's name). Each refuses if the previous artifact is missing.
Artifacts land in `backend/reset-runs/<UTC>/` (gitignored).

| Step | Command (via `.venv/bin/python -m …`) | Writes to production? | Artifact |
|---|---|---|---|
| 1 backup | `scripts.reset.backup run … --execute` | no (writes to the backup bucket + local dump) | `backup-manifest.json`, `mongo-<db>-<UTC>.archive.gz`, `storage-inventory-<UTC>.jsonl` |
| 2 verify | `scripts.reset.backup verify --manifest …` | no | verdict written into `backup-manifest.json` (`verify.passed`) |
| 3 plan | `scripts.reset.plan …` | no | `reset-manifest-<UTC>.json` (the FROZEN MANIFEST) |
| — review | the Owner opens the manifest; type `REVIEWED` | — | — |
| 4 rehearse | `scripts.reset.execute … --rehearse` | no | `reset-rehearsal-<UTC>.jsonl` |
| 5 execute | `scripts.reset.execute …` (type the project id + 12 sha chars) | **YES — deletes** | `reset-log-<UTC>.jsonl` + `.summary.json` |
| 6 seed | `scripts.reset.seed … --execute --password none/random/reset-link` | yes — creates accounts | `seed-result-<UTC>.json` |
| 7 postcheck | `scripts.reset.postcheck …` | no | `postcheck-<UTC>.json` |

Common flags on every command: `--project <id> --bucket <bucket> --mongo-db <db> --mongo-uri-env <NAME> --credentials <key.json>`.

### Refusals you may meet (all fail closed; exit code 2; nothing written)

* **backup**: key project ≠ typed project; env var not set; gcloud/mongodump/gsutil non-zero.
* **verify**: a dry-run manifest; a missing or altered artifact (sha256); the export's `.overall_export_metadata` not
  listed or no output files; the Storage copy count ≠ inventory count; the dump not a valid gzip/mongodump archive, not
  listing the database, or `mongorestore --dryRun` reporting it bad.
* **plan**: backup manifest missing / dry-run / not verified / other target / **older than one hour**; no canary;
  **any UNKNOWN** collection, subcollection, Storage prefix, undecided prefix with objects, or unfreezable `_id` type
  (a `reset-plan-refused-<UTC>.json` diagnostic is written); bucket missing; live project/db/bucket ≠ typed.
* **execute**: `demo-*` project; typed target ≠ manifest target; manifest not a reset manifest or carrying unknowns;
  `classification.py` changed since the plan (fingerprint); backup manifest changed (sha256), unverified or **older
  than one hour at execute time**; live Firestore project / bucket / Mongo db / Mongo hosts / canary ≠ manifest;
  the typed project id or the typed 12-character sha256 prefix wrong; stdin closed.
* **seed**: ≠ 1 observer; 0 or > 3 owners; invalid email / non-E.164 phone / duplicate / placeholder address;
  an Auth account carrying the Observer's email; an Owner's phone already on a different Auth account; no canary;
  project id not typed back.

### The freeze — why nothing created after the review can be deleted

`plan` takes `manifest_time` **before its first read** and lists the exact ids that exist. `execute` re-reads every id
and deletes it only if it still exists **and** its creation time (Firestore `create_time` / `createdAt`, Mongo
`created_at` / ObjectId time, Storage `time_created` + unchanged generation, Auth creation time) is **not later than
`manifest_time`**. Anything newer — or re-created under the same id — is logged `skipped_newer` and left alone. A re-run
of `execute` with the same manifest deletes nothing new: ids already gone log `already_absent`; only earlier `failed`
ids are completed. `postcheck` then lists post-manifest records separately; if there are any you care about, run
plan → review → execute again (a second pass is cheap and just as guarded).

Note: deleting `hostApplications` fires the Functions trigger `onHostInvitationWithdrawn`, which may remove `kyc/`
uploads before the Storage phase reaches them — those log `already_absent`, which is correct.

## After the run — before reopening

1. Owners: sign in to the CRM (email + password set via "Forgot password" / the printed password or link), enrol
   TOTP MFA, confirm the role is `superadmin` and every screen loads.
2. Observer: sign in at `/observer` with the one-time code; confirm read-only.
3. App: an Owner signs in with phone OTP and lands on `users/{uid}` created by the seed (`crmRole: superadmin`).
4. CRM Economy → Config: confirm `beanToDiamondRate`, `giftRates.beanToInrRate`, `weeklyMinPayoutInr` match the
   approved baseline (seed prints them and exits 1 while any is missing).
5. Notifications and the scheduled jobs: the next sweep writes to `scheduled_runs` (KEEP) as before.
6. Keep `backend/reset-runs/<UTC>/` and the backup bucket objects; they are the only record of what existed.

## Restoring from the backup (if ever needed)

* Firestore: `gcloud firestore import gs://<backup-bucket>/zipper-backups/firestore/<UTC>/ --project <id>`
  (restores every collection in the export; test on a scratch project first).
* MongoDB: `mongorestore --gzip --archive=reset-runs/<UTC>/mongo-<db>-<UTC>.archive.gz --nsInclude '<db>.*' --config <0600 yaml with uri:>`.
* Storage: `gsutil -m cp -r gs://<backup-bucket>/zipper-backups/storage/<UTC>/<prefix> gs://<bucket>/`.
* Auth accounts are not backed up by this tooling (Firebase has no per-project Auth export here); the seed recreates
  the Owners and Observer, and app users sign up again.

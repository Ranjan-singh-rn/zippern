# ZIPPER Phase 2 — Production baseline findings and revised MFA release plan

25 Oct 2026 · project `zipper-83816` · repo HEAD `1194e55`

**What was done.**
- One read-only, **metadata-only** production run.
- No `--with-sources` and no `--with-apk`.
- Production was not changed: nothing deployed, enabled, granted, created or updated.
- The repository was not changed:
  - no branch, commit, worktree or release folder;
  - no code changes;
  - outside `outputs/`, `git status` is the same 596 entries as before.
- New or updated files are under `outputs/` only:
  - this report;
  - the script, its launcher, and `release/proposed-mfa-patches/`.

---

## 1. The run

| | |
|---|---|
| Command | `bash outputs/release/collect-production-baseline.sh` (metadata only), started from `outputs/release/run-baseline-metadata.command` |
| How | I opened the launcher from Finder with your screen-control approval. Terminal is click-only for me, and Finder could not be driven while your screen was in a full-screen Space |
| When | 2026-10-25 07:38:47Z → 13:09:46 IST |
| gcloud | `~/google-cloud-sdk/bin/gcloud` |
| **Output directory** | **`~/zipper-baseline/20261025T073842Z/`** (mode 700). Console copy: `~/zipper-baseline/console-20261025T073842Z.txt` |
| Hardening before the run | `CLOUDSDK_CORE_DISABLE_PROMPTS=1`. gcloud otherwise offers "API not enabled — enable and retry? (y/N)"; now every such prompt takes its default ("no") |
| Leak check of the output | No personal e-mail, token, or secret value. The deployer is redacted, and env-var values were never fetched |

**A successful exit is not a complete baseline.** Component status:

| Component | Retrieved | Gap |
|---|---|---|
| Cloud Run | All of it: service, traffic, 30 revisions, env **names**, secret refs, builds, image retention | — |
| Functions | All 104 functions (generation, state, update time); 3 described in full; source bucket listings | Source archives not downloaded (by design) |
| Firestore rules | **Deployed text, exact**; release history | — |
| Storage rules | **Deployed text, exact**; release history | — |
| Indexes | **No** | `firestore.googleapis.com …/collectionGroups/-/indexes` returned **HTTP 400** (twice). The script now uses `gcloud firestore indexes composite list` / `fields list` instead (tested with fakes, not run). MFA needs no index change, so this does not block the MFA release |
| Hosting | Both sites: live and previous versions, config, file lists with hashes | — |
| IAM, APIs, secrets | All requested checks | — |
| Android | Update document (versions, sha256), 63 `appBuilds` objects md5-compared with local builds | — |

---

## 2. What production runs

Everything except the applinks site was released together on **20 Oct 2026, 08:25–09:05 UTC**. The Cloud Run revision is tagged `rc-1-2-5`, matching app version 1.2.5.

| Component | Live | Previous (rollback candidate) | Provenance |
|---|---|---|---|
| **Backend** (Cloud Run `zipper-api`) | `zipper-api-00046-siw` (20 Oct 08:26:21Z, 100%, tag `rc-1-2-5`); image `sha256:1f8a92a5…` | `00044-kat` (17 Oct, tag `rc-ugp`, 0%); `00042-vuz` (16 Oct, tag `rc-1-2-3`, 0%) | Built by Cloud Build `cf9a5236…` from `gs://run-sources-zipper-83816-asia-south1/services/zipper-api/1792484712.297548-88268622699a4d8d9c62b9f948e5cf1e.zip#1792484713419277` (1,654,135 bytes) |
| **Functions** | **104 functions** (95 gen1, 9 gen2), **all** updated 20 Oct 08:28–08:53Z. Second batch at 08:52–08:53Z: 13 functions incl. `backfillPublicProfiles` | Previous gen1 versions are kept as `version-N` source objects | The deployed set **equals the working tree's 104 exports**; HEAD exports 86 (18 deployed functions are not in HEAD, incl. `syncStorageRoleClaim`). Each gen1 function holds a copy of the upload (every copy is 1,005,931 bytes), e.g. `gs://gcf-sources-239458555881-asia-south1/backfillPublicProfiles-8325a949-43a8-4bb5-aa65-647e40df571e/version-22/function-source.zip` |
| **Firestore rules** | ruleset `b2104a12…` (20 Oct 08:54:35Z) | `bf1a3973…` (17 Oct 22:35Z) | **Byte-identical to the pre-P1 tree** (sha256 `17b8ffee…`); +1224/−190 vs HEAD. Owner-gate bypass audit: 0 |
| **Storage rules** | ruleset `27a73af8…` (20 Oct 08:54:51Z) | `5fd43571…` (16 Oct 21:05Z) | **Byte-identical to the pre-P1 tree** (sha256 `9899c24a…`). **Correction to the previous audit:** Storage rules *were* deployed (16 and 20 Oct). The "never deployed" comment in `firebase.json` is out of date. The deployed rules make **no cross-service (Firestore) calls** |
| **CRM** (Hosting `zipperlive`) | version `ba740f4158292308` (20 Oct 08:55:13Z, 324 files) | `8199a327ce27b898` (17 Oct, 313 files) | **Not** deployed from this repo's `.firebase` cache (which records 8 Oct; only 2 of 324 files match). Hosting holds built files only; see §4 |
| **Applinks** (Hosting `zipper-83816`) | `058ea60d…` (7 Oct) | `a3c1e1af…` (7 Oct) | Not part of this release |
| **Android** | `debug` channel only: versionCode **19** (1.2.5), `minSupportedVersionCode=19` (forces older installs to update), published 20 Oct 09:05:57Z | No downgrade possible | **Both published ABIs are byte-identical** (md5) to `zipper-app/build/published/debug/*/19.apk`, which contain no Owner work layer. `--with-apk` is **not needed** |

**Which working-tree changes are in production** (`PARTITION-SUMMARY.txt`; by file time against each live deploy):

| Component | Differ from HEAD | Changed **before** the deploy (in production) | Changed **after** | Created after |
|---|---|---|---|---|
| Backend image | 74 | 54 | 14 (all 13 P1-edited files, plus `core/roles.py`, edited 23 Oct by the earlier session work) | 6 (all P1) |
| Functions | 27 | 24 | 2 (`profiles.ts`, `storageClaims.ts`: P1) | 1 (`ownerMfa.ts`: P1) |
| CRM | 120 | 81 | 33 (12 P1 files + **21** files from the 22 Oct "B1 identity display" work) | 6 (B1 identity files incl. `frozen-money` page) |
| Rules | 1 + 1 | 0 | 1 + 1 (P1) | — |

**Conclusion.** Production is the pre-P1 working tree as of 20 Oct. No P1 work is in production: none of MFA, P1-B staff lifecycle, P1-D tickets, P1-E directory privacy or P1-A1. `git archive HEAD` would not reproduce any component: HEAD lacks 18 deployed functions and both deployed rulesets.

---

## 3. Source archives: what is available, and is downloading necessary?

| Archive | Location | Size | Expected contents (not yet seen) | Necessary? |
|---|---|---|---|---|
| **Backend** | `gs://run-sources-zipper-83816-asia-south1/services/zipper-api/1792484712.297548-88268622699a4d8d9c62b9f948e5cf1e.zip#1792484713419277` | 1.65 MB | The upload of the backend directory (`app/`, `scripts/`, `requirements.txt`, `Dockerfile`, maybe `tests/`). Uploads before 16 Oct were 63–65 MB, so these are filtered (no `.venv`). Whether `.env*` is inside is unknown | **Yes.** 7 files the MFA patch edits or relies on have uncertain production versions: `config.py`, `db/mongo.py`, `routers/auth.py`, `db/firebase.py`, `services/storage_claims.py`, `services/crm_directory.py`, `core/roles.py` |
| **Functions** (gen1, one upload) | `…/backfillPublicProfiles-8325a949-…/version-22/function-source.zip` | 1.0 MB | The Functions directory as packaged by firebase-tools (`src/`, `lib/`, `package.json` …). Very likely `.env`: the deployed functions carry env names `AGORA_APP_CERTIFICATE`, `AGORA_APP_ID`, `SG_MAIL_KEY`, `ZIPPER_API_BASE_URL` | **Only if** the Functions MFA hunks ship in this release. The bases of `profiles.ts` and `storageClaims.ts` are uncertain |
| Gen2 money-path functions | e.g. `gs://gcf-v2-sources-…/settleGift/function-source.zip` | — | — | **No.** MFA does not touch them |
| CRM | — | — | **Does not exist in production** (Hosting stores built files) | Not recoverable from production; see §4 |
| APK | `appBuilds/debug/*/zipper-1.2.5-19.apk` | — | Identical to the local builds | **No** |

**Proposed sequence (for your approval; the script supports it now):**

1. `bash outputs/release/collect-production-baseline.sh --list-sources`
   - This reads **only each zip's index**: file names and sizes from the central directory.
   - It does this with two byte-range reads (the last 1 KiB, then exactly the index).
   - For archives of this size (hundreds of entries), the 1 KiB tail lies inside the index, so no file contents are read. Even a tail that did reach file data would be compressed, never decompressed, and deleted at once.
   - Secret-looking names (`.env`, keys) are counted and listed by name.
   - This answers "what do they contain" before any download.
2. If the index looks as expected, run `--with-sources=backend`, and `--with-sources=functions` if Functions stay in scope.
   - Secret-looking files are never extracted.
   - Each archive is deleted once extracted.
   - The comparison then classifies every file as same-as-HEAD, same-as-pre-P1, same-as-working-tree or only-in-production.

The script fixes behind this were tested with fake `gcloud`/`curl`: guard, 0 leaks, clean degradation when access is denied. They matter because the first version would have failed here:
- Cloud Run stores the source location as a JSON map;
- gen1 Functions expose no archive path through the v1 API;
- the index listing needed a new route (the REST call returned 400).

---

## 4. Uncertain production baselines

1. **Backend.** The base is probable for 6 MFA-touched files: their pre-P1 copies were last modified 14–19 Oct, before the deploy. It is **uncertain** for the 7 files listed in §3. **Resolution:** the backend archive (step 2 above).

2. **Functions.** The deployed function *set* is exact. The bases of `profiles.ts` and `storageClaims.ts` are **uncertain**. **Resolution:** the Functions archive, or defer the two Functions hunks.

3. **CRM: the hard one.** Production's source is not stored anywhere in production.
   - 81 changed files predate the deploy, so the working tree has their production version.
   - **21 files were edited on 22 Oct** (the "B1 readable identity" work), and **6 were created after it**. Their 20 Oct content is not in the repo, not in git, and not in `outputs/`. The B1 report kept before-copies only of two Kotlin screens and `package.json`, in that session's scratch folder, which is not available here.
   - Options, for you:
     - **a.** Finder's "Go to Folder" history shows **`~/ZipperReleases/rc-20261020T085002Z/apk/`**. It is timestamped between the Functions batches and the rules, Hosting and Android releases of 20 Oct. If it holds the release inputs, it would give an exact CRM baseline, and possibly confirm the backend and Functions too. **May I read it (read-only, via folder access)?** I have not opened it.
     - **b.** Reconstruct the 21 files by reverting the B1 identity changes, then verify against the live Hosting hashes. That needs their old content, which we don't have.
     - **c.** Accept the B1 identity display changes (display-only per its report, but unrelated) into the CRM release. This contradicts MFA-only; it would be your call.
     - **d.** Stage the rollout so the backend ships first. Its MFA code is dormant with `OWNER_MFA_REQUIRED=false`, so the CRM baseline question can be settled without blocking it. The CRM and the Firestore MFA rules must ship together *after* that, because the rules lock Owners out of a CRM that cannot bind.

---

## 5. Configuration and IAM prerequisites

| Item | Status | Needed for MFA |
|---|---|---|
| Secret `OWNER_MFA_ENCRYPTION_KEY` | **Absent** (secrets present: `JWT_SECRET`, `MONGO_URI`, `SENDGRID_API_KEY`, 3 `SERVICE_KEY_*`, 3 `ZIPPER_*_KEY`) | **Hard prerequisite.** Without it, enrol and verify return 503 and the new CRM blocks Owners. Creating it is your change |
| Env `OWNER_MFA_REQUIRED` | Absent. The code default is **True** | The **first** MFA backend deploy must set it to `false` explicitly. Otherwise the current CRM's Owners are confined to MFA routes at once |
| Cloud Run env / secrets | Names **identical to `deploy.sh`'s lists** (10 plain, 6 secret) | Use `--update-env-vars` / `--update-secrets` (merge), never `deploy.sh`'s replace-all `--set-*` |
| Token Creator on the runtime service account (`239458555881-compute@…`) | **Present** | Custom-token minting: ✓ |
| IAM Credentials API | **Enabled** | ✓ |
| Storage service agent `roles/firebaserules.firestoreServiceAgent` | **Absent** (it has `roles/firebasestorage.serviceAgent` only) | **Needed only for the Storage MFA hunk** (the first cross-service read). Without it, Owner Storage access is denied (fail closed). **Decide:** grant it (your IAM change; the Firebase CLI also offers it on deploy), or defer Storage MFA. If deferred, Owner Storage privileges (KYC files etc.) stay gated by the role claim only, and a password-only Owner session keeps them |

**Pre-existing observations, outside MFA scope; reported only:**
- The 104 Functions carry `AGORA_APP_CERTIFICATE` and `SG_MAIL_KEY` as **plain environment variables**, from `functions/.env`. They are visible to anyone with Functions read access; Secret Manager would be the fix.
- The runtime service account has `roles/editor` on the project.

---

## 6. Rollback readiness

**The rollback targets are today's live IDs.** Rolling further back, to 17 Oct, would also undo the unrelated 20 Oct release.

| Target | Live (= rollback point) | Mechanism | Ready? |
|---|---|---|---|
| Backend | `zipper-api-00046-siw` / `sha256:1f8a92a5…` | Deploy the MFA revision with `--no-traffic --tag`, test the tag URL, migrate. Roll back by sending traffic to `00046-siw` | **Yes.** Its image is retained: the repository has no cleanup policy (2.4 GB). `00044` and `00042` are also Ready |
| Firestore rules | `b2104a12…` (text saved in `firestore.rules.DEPLOYED`) | Re-release this ruleset | **Yes** |
| Storage rules | `27a73af8…` (text saved) | Re-release | **Yes** |
| Hosting | `ba740f4158292308` | Console rollback, or clone the version to live | **Yes**, if version retention keeps it (console setting not visible here) |
| Functions | `backfillPublicProfiles` version 22, `syncStorageRoleClaim` version 6 | Redeploy the previous source of those two functions | **Partly.** It needs the version-22 source (the archive) and the `.env` names listed above |
| Android | Not in this release | — | — |

---

## 7. Dependency map: what changed against the actual deployed source

1. **Storage MFA** moves from "independent" to **in scope, blocked on the IAM decision**. The claim-based Storage design *is* live: rules and `syncStorageRoleClaim` were deployed 20 Oct. Owner Storage access is therefore real and currently not MFA-gated.
2. **The `mfa_sid` strips** in `storageClaims.ts` and `storage_claims.py` are in scope, because both claim writers are live.
3. **Rules base:** the pre-P1 text is exactly production, so the Firestore MFA patch is **exact**.
4. **P1-B, P1-D, P1-E and P1-A1** are confirmed absent from production and stay out (Decisions 2 and 3).
5. **Android:** confirmed out. Production APK 19 has no Owner work layer.
6. **Indexes:** MFA needs none. The live list is still unknown (HTTP 400), so no index deploy may happen until it is retrieved.

---

## 8. Proposed MFA-only patches (for review; nothing applied)

There are 29 diffs in `outputs/release/proposed-mfa-patches/`. Their bases and included or excluded hunks are in `MANIFEST.json`, and an overview is in `README.md`.

| Component | Files | Base |
|---|---|---|
| Rules | `firestore.rules` (+61/−24): `crmRole()` gate, `hasPerm()` refusal, `ownerMfaSessions` deny-all, Owner `gateAnswers` arm removed (**ship after the MFA CRM**). `storage.rules` (+33/−1) | **Exact** |
| Backend | `owner_mfa.py` (new); `routers/auth.py`, `core/security.py`, `core/deps.py`, `config.py`, `db/mongo.py`, `db/firebase.py`, `core/audit.py` (MFA actions only), `main.py` (expose header only), `services/storage_claims.py`, `services/staff.py` (**below**); `scripts/remove_gate_answers.py` (post-rollout) | probable / uncertain |
| Functions | `ownerMfa.ts` (new), `profiles.ts`, `storageClaims.ts` | uncertain |
| CRM | `login/page.tsx`, `lib/api.ts` (MFA hunks only), `lib/auth.ts` (gate removal only), `team/page.tsx` (narrow adaptation: an Observer-only "Reset two-step sign-in" using the page's own `Modal`/`Field`/`Footer`; **no** suspend/reactivate) | head / probable / uncertain |

### The narrow `deactivate()` hook (Decision 3)

**Verified against the probable production `services/staff.py`.** That is the pre-P1 copy, last modified 14 Oct, before the deploy; to be confirmed against the archive.

How production behaves today:
- **`deactivate()`** works in this order:
  1. revokes the API sessions;
  2. sets `is_active=false`;
  3. **disables the Firebase login**;
  4. mirrors `crmUsers.isActive=false`;
  5. clears the Storage role claim.

  Owners can be deactivated by the Observer only, and never the last active Owner.
- **There is no reactivation path in production code.** `invite()` refuses an existing staff row; `change_role()` and `set_employment()` keep `is_active` as it is; nothing calls `set_user_disabled(uid, False)`. A reinstatement today is an **out-of-band** re-enable.
- **Re-enabling does not revoke refresh tokens.** The code says so explicitly (`users.py`). An old custom-token browser session would therefore resume with the same `mfa_sid` and `auth_time`.

**The patch:**
- Right after the session revocation, for Owners only, `deactivate()` calls `owner_mfa.clear_all_bindings(uid, "Owner deactivated", actor)`, which deletes every binding.
- It reports the outcome as `owner_mfa_bindings` ("cleared", "NOT CLEARED – deactivate again to retry", or "n/a" for non-Owners). `fully_revoked` is now false if the clear failed.
- `change_role()` gets the existing P1 one-line hook.
- **Nothing from P1-B** comes along: no status model, suspend/reactivate, notices or partner-conflict checks.

**Tests** (`tests/test_p2_owner_deactivate_mfa.py`, 20 checks), covering:
- all bindings (CRM and Android) are deleted, and **before** the login is disabled;
- the deletion is audited;
- bound sessions fail the rules' Owner check;
- **after an out-of-band reinstatement:**
  - the old session, refreshed with the same `sid` and `auth_time`, is still refused;
  - it cannot be confirmed against a new or its own revoked API session;
  - a fresh MFA sign-in gets a **new** `sid` while the old one stays dead;
- a failed clear is reported and the rest of the revocation still happens; deactivating again clears it;
- non-Owners are never touched;
- source pins (order, Owner-only, no P1-B).

**Verified in session scratch (`/tmp`), never in the repo:**

| Check | Result |
|---|---|
| Backend tree = probable production + all MFA-only patches | Every module compiles; all `app.*` imports resolve; **84/85 test modules pass**. The new test is 20/20, the pre-P1 `test_staff_revocation` 38/38 with the hook, `test_partner_session` 531, `test_permissions` 246. The 85th reads `backend/.env.example`, which I never open |
| Mutation: hook removed | **12 of 20** checks fail, including every revival check |
| Mutation: failure hidden from `fully_revoked` | 1 fails |
| CRM tree = probable production + MFA-only patches | `tsc` passes; `npm test` passes all 20 suites |
| Firestore MFA-only rules | Bypass audit 0; balanced; no P1-A1/D/E content |
| Rules emulator suites | Run on your Mac in the release folder, all suites except `p1gov` (it tests the excluded rules) |

---

## 9. Revised release plan (each step needs your approval)

1. **Provenance**, in this order:
   1. `--list-sources`;
   2. `--with-sources=backend`, and `=functions` if in scope;
   3. your answer on `~/ZipperReleases/rc-20261020T085002Z/`;
   4. the CRM baseline decision (§4).
2. **Rebase** the "uncertain" and "probable" patches onto the exact sources, and re-run the scratch verification.
3. **Release folder** `~/zipper-release/<id>/`, per component: baseline plus the reviewed patches only. Also:
   - `MANIFEST.json` with sha256 per file and artifact hashes;
   - secret scan, where any finding blocks;
   - a backend `.gcloudignore`;
   - full tests per component.
4. **Your configuration steps:**
   - create `OWNER_MFA_ENCRYPTION_KEY`;
   - decide the Storage IAM grant.
5. **Rollout:**
   1. backend with `OWNER_MFA_REQUIRED=false` (no-traffic tag → verify → migrate);
   2. CRM;
   3. Owners enrol;
   4. `OWNER_MFA_REQUIRED=true`;
   5. Firestore rules (incl. the `gateAnswers` removal);
   6. Storage rules, if IAM was granted;
   7. the two Functions;
   8. `remove_gate_answers.py`, with separate approval.

   Rollback points are listed in §6.

**Stopped here, as instructed.** Nothing else will be downloaded, created, changed or deployed until you review.

# ZIPPER Phase 2 — Source provenance: archives, the 20 Oct release folder, CRM and backend

25 Oct 2026. Read-only throughout:
- **Production:** nothing changed. Nothing deployed, enabled, granted or created.
- **Repository:** nothing changed. Outside `outputs/`, `git status` is the same 596 entries; no branch, commit or worktree.
- **Release folder:** not created.
- **Functions source:** not downloaded.
- **Scripts:** nothing from the release folder was executed.

**Evidence folders** (both mode 700):
- `~/zipper-baseline/20261025T085009Z/`: the index-only run (`--list-sources`).
- `~/zipper-baseline/20261025T090632Z/`: the backend-only download (`--with-sources=backend`). I opened its launcher from Finder with your screen approval.

## 1. Archive inventory and safety concerns

| | Backend (Cloud Run source) | Functions (gen1 upload) — **not downloaded** |
|---|---|---|
| Object | `run-sources-…/zipper-api/1792484712.297548-88268622699a4d8d9c62b9f948e5cf1e.zip#1792484713419277` | `gcf-sources-…/backfillPublicProfiles-8325a949-…/version-22/function-source.zip` |
| Entries / size | 224 entries, 5.6 MB uncompressed; archive 1,654,135 bytes, sha256 `362270600a2dbd67…` | 163 entries, 3.1 MB uncompressed |
| Top level | `app/` 96, `scripts/` 35, `tests/` 85, `Dockerfile`, `requirements.txt`, `.dockerignore`, `.python-version`, 3 docs | `src/` 32, `lib/` 64, `test/` 54, 7 maintenance `.mjs` scripts, `package*.json`, `tsconfig.json` |
| Secret-looking names | **`.env.example` only** (never extracted). **No `.env`, `.env.local` or key files** | **`.env` and `.runtimeconfig.json`** |
| Unsafe paths / duplicates / links | none | none |

**Concerns.**
- **Functions archive.** It holds `.env` and `.runtimeconfig.json`, so anyone with read access to the `gcf-sources-*` bucket can read them. This is a pre-existing exposure. The deployed functions also carry `AGORA_APP_CERTIFICATE` and `SG_MAIL_KEY` as plain env vars. Fixing this is outside MFA scope.
- **Backend archive: clean.** A content scan of all extracted files flagged **19 lines; all are false positives.** I checked them without printing any value:
  - **6** are Secret Manager secret *names* in `scripts/generate_service_key.py`. Each value equals one of the listed secret names.
  - **13** are test placeholders or deliberate canaries in 6 `tests/` files. For example, `test_local_isolation.py` labels its strings "obviously not a credential: a canary string".
  - Every flagged file is byte-identical to the repo's working-tree copy, so the download exposed nothing new.
- **Hardening done before the download** (tested with fakes):
  - size limits that refuse oversized archives (zip bombs);
  - path containment for every extracted file;
  - an **exact-generation-only** download (the silent fallback is removed);
  - the archive's sha256 recorded;
  - a content scan that records file, line and rule, never values;
  - cleanup on interrupt (tested: exit 130, nothing left behind).
- **Already in place:** extraction only into a new folder; secret-looking names never extracted; symlinks skipped; files mode 600, folders 700; the archive deleted once extracted; nothing ever executed.

## 2. The 20 Oct release folder

`~/ZipperReleases/rc-20261020T085002Z/` exists. I inspected it read-only, starting with listings and metadata. It contains exactly two files:
- `apk/ZIPPER-1.2.5-19-debug-armeabi-v7a.apk` (80,373,831 bytes). Its sha256 `3fa9cee7…` is identical to the production `armeabi-v7a` build and to `zipper-app/build/published/debug/armeabi-v7a/19.apk`.
- `apk/.DS_Store` (Finder metadata, not opened).

**It holds no CRM, backend or Functions inputs.** It is an Android hand-off copy, and Android is out of scope.

## 3. CRM: what can be proven to match the live Hosting version

> **Correction (25 Oct, later).** This section's conclusion is wrong: the 20 Oct baseline *is* provable. The deploy run's own records were in Claude's working folder, and this investigation missed them.
>
> **How it is proved.**
> - The deploy run (`deploy-rc-20261020T085002Z`) built the CRM from a release tree with id `947c9fe72ecf2a29`. That tree was HEAD `1194e55` plus 488 listed files, each pinned by `release-manifest-rc.sha256`.
> - The tree produced build `q-z53piONkH44nYVJHLF6`. Production's file list for `ba740f4158292308` contains that build id.
>
> **The 21 files.** All 21 are recovered and match the deployed content:
> - 20 come from a backup taken before the 22 Oct edits;
> - `CommissionLedger.tsx` comes from HEAD.
>
> The evidence is in `~/zipper-baseline/crm-20oct-baseline-20261025T140342Z/` (`EVIDENCE.md`).
>
> **Patch bases.** The same manifest proves the CRM and Functions MFA patch bases exact.

The live version is `ba740f4158292308`: 324 files, released 20 Oct 08:55:13Z.

**No CRM source file can be proven to match.** The evidence:
- **No local copy of the 20 Oct build exists.**
  - `zipper-crm/out` and `.next` are both from the 16 Oct build.
  - This repo's only deploy cache records 8 Oct. The 16/17/20 Oct deploys ran from another checkout whose `.firebase` cache is not here.
  - The release folder holds only the APK.
- **Asset level.** Exactly two files are provably identical to live:
  - `/_next/static/chunks/polyfills-78c92fac7aa8fdd8.js`. It has the same content-hashed name in the 16 Oct build, and the same Hosting hash in the 8 Oct deploy.
  - `/lottie-test.html`, with the same Hosting hash in the 8 Oct deploy.
  - No other content-hashed chunk name is shared between any local build and live.
- **Hosting hashes can't be reproduced here.** Firebase's file hash (sha256 of the gzip stream) did not reproduce in the sandbox for those known-identical files. Node's bundled zlib output depends on the machine, and the deploys ran on your Apple-Silicon Mac. A hash proof would have to be computed on that Mac.
- **Routes.** All 89 current CRM routes exist in the live build, including `/frozen-money`, `/recharges`, `/role-appeals`, `/transfers` and `/appeal`. **Correction:** my earlier "created after the deploy" class (from file birth-times) is unreliable. Editors that save by replacing the file reset the birth-time, and `/frozen-money` was live on 20 Oct.
- **Contents.** 33 CRM files changed after the deploy: 12 P1 and 21 from the 22 Oct B1 identity work. Their 20 Oct content is not in git, the repo, `outputs/` or the release folder. **HEAD is not a substitute.** Most of the 21 differ from HEAD in many lines unrelated to identity display, for example:
  - `finance/withdrawals` 280 lines;
  - `PartnerApplications.tsx` 252 lines;
  - `agencies/[id]/Client.tsx` 251 lines.

  So their 20 Oct versions were neither HEAD nor today's files.

**Options. You choose; I won't guess:**

| Option | What it gives | Needs |
|---|---|---|
| **a. Find the checkout the 16/17/20 Oct deploys came from** (it holds its own `.firebase/hosting.*.cache` and possibly the deployed `zipper-crm/out`) | Possibly the exact build and source | You tell me where; access approval |
| **b. Editor local history or Time Machine** (VS Code, Antigravity or Sublime keep per-file history) | The pre-22 Oct versions of the 21 files | Your approval to read those folders read-only |
| **c. Verification by rebuild** | Proof per page. Next.js chunk *filenames* carry content hashes, so a candidate source whose rebuilt chunk names equal live's is proven, with no gzip hash needed | Candidate sources (from a or b) plus approval for a scratch build. The build needs `zipper-crm/.env.local`, which I never open, so it would run on your Mac |
| **d. Fingerprint the live bundle** (HTTP GET of the public JS chunks for the 21 pages) | Evidence of which version each page ran; not an exact source | Approval to download public live assets |
| **e. Defer the CRM** | Ship the backend MFA dormant (`OWNER_MFA_REQUIRED=false`) first; the current CRM keeps working. The CRM and the Firestore MFA rules follow once the baseline is settled | Nothing extra now |

## 4. Backend: production versus the repository (exact)

Production backend = the extracted archive. Classification of `app/`, `scripts/`, `requirements.txt` and `Dockerfile`:

| Class | Count | Files |
|---|---|---|
| Same as the working tree | **111** | everything not listed below |
| Same as the **pre-P1 copy** (P1 edited it later) | **12** | `config.py`, `core/account_state.py`, `core/audit.py`, `core/deps.py`, `core/security.py`, `db/firebase.py`, `db/mongo.py`, `main.py`, `routers/staff.py`, `services/crm_directory.py`, `services/staff.py`, `services/storage_claims.py` |
| Same as **HEAD** (changed after the deploy, not by P1) | **2** | `core/roles.py` and `routers/auth.py`: the 23 Oct mobile `capability_profile` work. **Not in production; excluded** |
| Differs from all of them / only in production | **0** | — |
| Absent from production | 6 | all P1-created: `owner_mfa.py`, `routers/tickets.py`, `services/tickets.py`, 3 scripts |

**Also:**
- **Tests.** Production's tests equal the pre-P1 copies for every test the MFA patches touch.
- **Rules.** Unchanged: both deployed rulesets are byte-identical to the pre-P1 tree.
- **Indexes.** Now retrieved: 58 composite indexes and 4 field overrides. The composite indexes are **identical to the pre-P1 file**. The working tree has one more, P1-E `staffRoster`, which is not in this release.

**Patch consequences (proposals updated; nothing applied):**
- Every backend and test base is now **exact**.
- `routers/auth.py` was **rebased onto production's file**. It adds exactly the 213 P1 MFA lines, and none of the capability change.
- **Validated on the exact production backend plus the MFA-only patches** (sandbox `/tmp` only):
  - 80 of 82 test modules pass, including the deactivation test (20/20) and `test_staff_revocation` (38).
  - Both failures are environmental: `.env.example` is never extracted, and `test_commission` reads a local `backend/backups/…` file that isn't in the archive and that I haven't opened.

## 5. Is the next step safe, and what still needs approval

**Safe and exact now:**
- the backend part of the MFA release (exact bases, exact patches, validated);
- the Firestore rules part (exact base; ship it with or after the MFA CRM).

**Still needs your approval or decision:**
1. **Create the release folder** `~/zipper-release/<id>/`, starting with the backend and Firestore rules.
2. **Functions archive download.** It is needed only to make the two Functions MFA hunks exact:
   - `backfillPublicProfiles` binding gate;
   - `mfa_sid` strip in `storageClaims.ts`.

   It would download the 1.0 MB archive; `.env` and `.runtimeconfig.json` would be counted but never extracted. Alternatively, defer those two hunks.
3. **CRM provenance path:** options a–e above.
4. **Unchanged prerequisites:**
   - create `OWNER_MFA_ENCRYPTION_KEY`, which is yours to create;
   - first backend deploy with `OWNER_MFA_REQUIRED=false`;
   - Storage MFA and its IAM grant stay deferred;
   - Android stays out.

**Script changes this turn** (production untouched):
- the download hardening listed in §1;
- the backend-only launcher `outputs/release/run-baseline-backend-source.command`.

I've stopped here: no release artifact built, nothing deployed.

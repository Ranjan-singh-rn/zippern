# Release isolation: dependency map and proposed strategy (for approval)

25 Oct 2026. Read-only analysis. No branch, commit, worktree or deployment was created.

## 1. The precise blocker

1. **Every deploy mechanism ships the working tree** (`deploy.sh`, `deploy-crm.command`):
   - backend: `gcloud run deploy --source .` from `backend/`;
   - Functions: build all of `functions/src`;
   - CRM: `npm run build` of all of `zipper-crm`, then Hosting `zipper-crm/out`;
   - rules: whole files.

   None can select hunks or files.
2. **The release baseline is unknown.** HEAD is `1194e55` (5 Oct). Much of what the MFA path imports is **untracked**, not merely modified: `services/notices.py`, `services/storage_claims.py` and the entire Android work layer (`data/work/*`, `ApiClient.kt`). If earlier releases were deployed from this dirty tree (likely), **production already runs code that is not in git**. A "HEAD + MFA" release would then **roll production back**. "Exclude unrelated changes" can only be defined against **what is deployed now**, and that is a production read I am not allowed to do.

So the deploy scripts cannot isolate this release. **Stopping here, as instructed.**

## 2. What the MFA fix depends on

| Target | MFA files | Earlier Phase 1 prerequisites they need | Pre-existing (pre-P1) work mixed into the same files |
|---|---|---|---|
| **Backend** | `services/owner_mfa.py` (untracked), `routers/auth.py`, `core/security.py`, `core/deps.py`, `core/audit.py`, `config.py`, `db/mongo.py`, `main.py` (CORS header) | **A3** TOTP (in `owner_mfa.py`, `deps._refuse_owner_without_mfa`, security `mfa` claim). **B** staff lifecycle (`services/staff.py` `_change_status`, suspend/reactivate, `routers/staff.py`, `core/account_state.py`), which the binding clears hook into | `staff.py` 156 lines; `security.py` 110; `deps.py` 110; `config.py` 58; `mongo.py` 127; `audit.py` 30; `main.py` 35. **Imports of untracked files:** `services/notices.py`, `services/storage_claims.py`, `services/email.py` (modified) |
| **Firestore rules** | `crmRole`/`ownerMfaKey`/`ownerMfaOk`/`hasPerm`, the `ownerMfaSessions` block | **A3** gate-arm removal, which pairs with the CRM login page that no longer writes `gateAnswers` | **1,414 pre-P1 changed lines**, plus P1 A1/D (tickets lockdown) and E (`crmUsers` privacy, `staffRoster`), which pair with CRM changes |
| **Storage rules** | `rawRoleClaim`/`ownerMfaOk`/`roleClaim` | — | 648 pre-MFA changed lines |
| **Functions** | `src/ownerMfa.ts` (new), `src/profiles.ts` | — | `profiles.ts` 14 lines; 39 modified + 54 untracked files elsewhere would be built too |
| **CRM** | `lib/api.ts` (MFA client), `app/login/page.tsx` (MFA screens, gate removal) | **A3** (`lib/auth.ts` gate removal). `lib/api.ts` also carries **D** (`tickets` API) and **B** (staff suspend/reactivate); `lib/auth.ts` carries **E** (`getDeptStaff` → `staffRoster`), which **requires the E rules and the roster backfill**, or pickers break | `api.ts` 334 lines; `auth.ts` 244. `login/page.tsx` is P1-only |
| **Android** | `data/api/ApiClient.kt`, `data/work/ModulesOps.kt` | the **entire B3 work layer**, which is untracked: `WorkRepository`, `WorkModules`, `Caps`, … | the whole work layer is pre-P1 untracked work |

**What is not required** (it can be excluded or left in, but must not ship half-way):
- **D** tickets (backend `services/tickets.py`, `routers/tickets.py`, rules ticket lockdown, CRM ticket callers): rules plus backend plus CRM must move together.
- **E** directory privacy (rules, `crm_directory` roster, CRM `getDeptStaff`, roster backfill script): rules and CRM move together, after the backfill.

## 3. Proposed strategy

**Step 1 — establish the production baseline (you, read-only; I may not).**
- Firestore and Storage rules: export the currently released versions (Console → Rules → history, or the Rules REST API `projects.releases.get` / `rulesets.get`). Save them as `outputs/release/baseline/{firestore,storage}.rules`.
- Cloud Run: `gcloud run revisions describe <current>`, to get the image and source archive (`gcloud builds describe` for the source upload).
- Functions: `gcloud functions describe` for each function, to get the source upload location; download the source zip.
- Hosting: `firebase hosting:releases:list` (or Console) and the current release version.

**Step 2 — diff the baseline against the working tree, per target.**
- That diff is what a working-tree deploy would actually change in production.
- Classify every hunk into: MFA, A3, B, D, E, pre-existing reviewed, or not reviewed.
- You decide what is in the release.

**Step 3 — build in an isolated copy, without touching this tree or git history.**
- `git archive` is read-only on the repository, writes nothing to `.git`, and needs no branch or commit:
  ```
  mkdir -p ~/zipper-release && git archive HEAD | tar -x -C ~/zipper-release
  ```
  If the baseline is not HEAD, use the downloaded production sources as the base instead.
- Copy in, file by file, the reviewed set (new files whole; mixed files from a curated patch made with `git diff -- <file>` and reviewed hunks). The working tree is never modified.
- Build each artifact **inside the copy**: backend source tarball, `functions` build, CRM `npm run build` plus `npm run verify:out` (the existing freshness and hash check), the rules files, the APK.
- **Inspect before deploying:** diff each artifact against the baseline, check the rules sha256, check that every file in the copy is in the approved list, and run every test suite **in the copy**.

**Step 4 — deploy from the copy only**, with explicit commands (not `deploy.sh`, which also re-runs secrets and IAM steps), in this order:
1. backend;
2. CRM and Android;
3. Functions;
4. Firestore and Storage rules.

You run these. Rollback is per target to the Step-1 baseline.

**Alternative:** `git worktree add --detach <dir> HEAD` gives the same isolation with git tooling. It writes worktree metadata into `.git`, though no branch and no commit, so it is your call, not mine.

## 4. Decisions needed

1. Do Step 1 (read-only production export), or authorise me to guide you through it.
2. Decide the release contents per target from the Step-2 diff. In particular, whether D and E ship now (they then need the roster backfill and their rules together).
3. Approve `git archive` (preferred) or the `git worktree --detach` copy.

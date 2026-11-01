# ZIPPER credential rotation — FINAL PHASE runbook

**PREPARED ONLY. Nothing in this folder runs until the owner approves the final phase.** Approval = the owner creates
the file `FINAL-PHASE-APPROVED` in this folder (`touch FINAL-PHASE-APPROVED`), and only after the completion release
is accepted — step 13 of `../completion-20261101/RUNBOOK.md`. Every `rot-*.command` checks for that file first and
refuses (exit 2) before calling any tool. Remove the file when the phase is over.

## 0. Rules (enforced by the scripts where marked)

- **Gate** (enforced): `FINAL-PHASE-APPROVED` must exist. It and `production/` are git-ignored (`.gitignore`), so
  neither trips the clean-tree check.
- **Integrity** (enforced): every script refuses if `rot_common.sh`, `rot_helpers.py` or a `rot-*.command` differs from
  this folder's own `SCRIPTS.sha256` (separate from the completion release's), if the working tree is dirty, or if HEAD
  is not the released commit in `../completion-20261101/RELEASE.txt`. Rotation changes no code.
- **Words** (enforced): one typed word per production change; anything else stops with exit 4 and nothing changed.
- **Values**: you paste every new value straight into the Secret Manager console (*New version*) or the issuer's
  console. No script reads, prints, pipes or stores a value, and none uses Secret Manager's access verb. Never paste a
  value into Terminal, chat, a ticket or a screenshot. Random values come from a password manager, at least 32
  characters (the backend minimum for `JWT_SECRET` and `SERVICE_KEY_*`).
- **Versions** (enforced): never destroyed — only disabled (`rot-90`, reversible with `rot-91`), and only after the
  rollback window (default 7 days, `ROT_WINDOW_DAYS`). Disabling does **not** revoke a key at its issuer: the
  SendGrid / Agora / Atlas steps below do that.
- **Traffic** (enforced): moved by revision name only; `zipper-api-00048-pit` never receives traffic.
- **Timing** (enforced in 80/85): never within 2 hours of the Sunday financial runs (16:29–21:00 UTC on Sundays).
- Run `./rot-00-inventory-readonly.command` before and after every rotation. Evidence of every run:
  `production/<id>-<UTC>/SUMMARY.txt` (`stderr.log` may name the operator account — do not share it).

## 1. Inventory (names only — no value appears anywhere in this folder)

| # | Credential | Where it lives | Read by (dependants) | Path |
|---|---|---|---|---|
| 1 | SendGrid API key | Secret Manager `ZIPPER_SENDGRID_API_KEY` — **v1 was seen in a screenshot: replace it first**. Older keys: `SG_MAIL_KEY` in `functions/.env` (environment of ALL functions); Secret Manager `SENDGRID_API_KEY` (`:latest`, BASE revision `zipper-api-00046-siw`) | the 8 e-mail functions + `weeklyPayoutReportGenerator` (version pinned at deploy); the completion backend revision as `SENDGRID_API_KEY=ZIPPER_SENDGRID_API_KEY:1` | §3.1 |
| 2 | Agora App Certificate | `AGORA_APP_CERTIFICATE` in `functions/.env` (environment of ALL functions); embedded in old APKs 12–14 and in git history. APK 20 does not embed it (tokens are minted by the server) | `generateAgoraToken` only | §3.2 |
| 3 | Service keys, 3 pairs (same value per pair) | backend `SERVICE_KEY_WEEKLY_ACCRUAL` / `SERVICE_KEY_REPORTING` / `SERVICE_KEY_PARTNER_REGISTRATION` (Secret Manager, `:latest`) ↔ Functions `ZIPPER_ACCRUAL_KEY` / `ZIPPER_REPORTING_KEY` / `ZIPPER_PARTNER_REGISTRATION_KEY` | `weeklyPayoutReportGenerator`; the 7 `scheduled*` jobs; `registerAgencyPartner`, `registerSellerPartner` and the partner callables. The backend compares ONE key by digest (DEPLOYMENT.md §8/§9) | §3.3 |
| 4 | `JWT_SECRET` | Secret Manager, backend `:latest` | every API session | §3.4 |
| 5 | `MONGO_URI` | Secret Manager, backend `:latest`; your local `backend/.env` for the Mac scripts | backend; reset/backfill scripts on the Mac | §3.5 |
| 6 | `OWNER_MFA_ENCRYPTION_KEY` | Secret Manager, backend pinned `:1` | the stored TOTP enrolments of every Owner and the Observer | §3.6 |
| 7 | Android debug keystore | the Mac (`~/.android/debug.keystore`) | the signature every installed APK trusts | §3.7 (not rotated) |
| 8 | Firebase web API keys | inside every APK and the CRM bundle (public by design) | Firebase client SDKs | §3.8 (restrict) |
| 9 | People: Google accounts with project roles, Owner accounts | IAM, Firebase Auth | — | §3.9 |
| 10 | Firebase Admin service-account key file(s) used by the backend scripts on the Mac *(found while preparing; not in the original list)* | user-managed service-account keys (rot-00 lists id prefixes and dates) | `backend/scripts/*`, the completion release's read-only tools and `publish_apk.py` | §3.9 |

## 2. Building blocks

| Script | What it does | Words |
|---|---|---|
| `rot-00-inventory-readonly.command` | metadata only: versions/states, which revision/function pins which version, `.env` name counts, API-key restrictions, SA key ids, people per role | — |
| `rot-80-backend-secret.command <ENV> pin` | new zipper-api revision (0%) pinning `<ENV>` to the newest ENABLED version — the value it already uses — then traffic to it | `PIN`, `SHIFT` |
| `rot-80-backend-secret.command <ENV> switch` | new revision pinning the newer version you added, then traffic | `NEWREV`, `SHIFT` (`SIGNOUT` for `JWT_SECRET`, `REENROL` for `OWNER_MFA_ENCRYPTION_KEY`) |
| `rot-80-backend-secret.command <ENV> back` | traffic back to the revision that served before the last pin/switch (recorded) — also automatic if the new revision is not Ready or `/api/health` is not 200 within 120 s | `BACK` |
| `rot-85-functions-redeploy.command <SECRET>` | redeploys every function that references the secret today, unchanged code (git archive of the released HEAD + a copy of `functions/.env`); Firebase pins the newest ENABLED version | `REDEPLOY` |
| `rot-85-functions-redeploy.command AGORA` | redeploys `generateAgoraToken` only, with the new `AGORA_APP_CERTIFICATE` you put in `functions/.env` | `REDEPLOY` |
| `rot-90-disable-old-version.command <SECRET> <N>` | disables version N after the window; refuses while the template, a revision with traffic or a function still uses it. If N is the newest enabled version (retiring a secret, e.g. the old `SENDGRID_API_KEY`), nothing in use may reference the secret at any version; 0% revisions that would no longer start are listed | `DISABLE` |
| `rot-91-enable-version.command <SECRET> <N>` | re-enables N (rollback of 90) | `ENABLE` |

`<ENV>` is one of `JWT_SECRET MONGO_URI SERVICE_KEY_WEEKLY_ACCRUAL SERVICE_KEY_REPORTING SERVICE_KEY_PARTNER_REGISTRATION
OWNER_MFA_ENCRYPTION_KEY SENDGRID_API_KEY`. **Why `pin` first:** Cloud Run resolves `:latest` whenever an instance
starts, so a version added to a `:latest` secret reaches new instances of the serving revision unannounced, and pinning
traffic back to a `:latest` revision would not restore the old value. `pin` changes nothing, and makes `switch` the
single, visible change and `BACK` a real rollback.

## 3. Per credential

### 3.1 SendGrid — first (v1 was exposed)
1. MANUAL: SendGrid → API Keys → Create (*Restricted*, Mail Send only, name `zipper-<date>`) → paste it straight into
   Secret Manager → `ZIPPER_SENDGRID_API_KEY` → New version (v2).
2. `./rot-85-functions-redeploy.command ZIPPER_SENDGRID_API_KEY` — `REDEPLOY` (the 9 functions pin v2).
3. `./rot-80-backend-secret.command SENDGRID_API_KEY switch` — `NEWREV`, `SHIFT` (already pinned to `:1`; no pin step).
4. Verify: one controlled e-mail (CRM Observer sign-in code to the delivery mailbox: From, SPF/DKIM pass); mail log
   counts (backend `accepted (` / `FAILED (HTTP`, functions `transactional mail sent/failed`) via the completion
   release's 90 script or Cloud Logging; `rot-00` shows v2 everywhere and v1 on no revision with traffic.
5. Revoke within hours (the key leaked): SendGrid → delete the key behind v1; then
   `ROT_WINDOW_DAYS=0 ./rot-90-disable-old-version.command ZIPPER_SENDGRID_API_KEY 1` — `DISABLE`.
6. Older keys, after the completion release is accepted (they are its rollback paths: 19's BASE revision and sg-C9):
   delete them at SendGrid, then `rot-90 SENDGRID_API_KEY <n>`. `SG_MAIL_KEY` stays as a dead value in
   `functions/.env` until a separate change removes it (removal shows `only-deployed` for every function in the
   release scripts' env-drift check).
- **Rollback window:** until the old key is deleted at SendGrid. Backend: `rot-80 SENDGRID_API_KEY back` (`BACK`)
  restores v1 at once. Functions pin the newest ENABLED version, so fix forward (paste a corrected key as v3, repeat 2).
- **Approval line:** "Final phase §3.1 SendGrid: run rot-85 ZIPPER_SENDGRID_API_KEY, rot-80 SENDGRID_API_KEY switch,
  revoke v1 at SendGrid, rot-90 v1."

### 3.2 Agora App Certificate
Precondition (85 checks the first): completion wave 2b live (21 evidence PASS); APK 20 published with
`minSupportedVersionCode` 20 and the fleet updated.
1. MANUAL: Agora console → project → App certificate → enable the **secondary** certificate.
2. MANUAL: in an editor, set `AGORA_APP_CERTIFICATE` in `functions/.env` to the secondary value (never echo/cat it).
3. `./rot-85-functions-redeploy.command AGORA` — `REDEPLOY` (`generateAgoraToken` only; it refuses unless exactly that
   value differs from what the function runs with).
4. Verify: a live room and a 1:1 call on APK 20 (both certificates are valid while both are enabled); the ERROR count
   for `generateAgoraToken` printed by 85.
5. After the window: Agora console → make the secondary the primary and delete the old certificate. The value in old
   APKs 12–14 and in git history is then dead.
- Every other function keeps the old value in its environment (none reads it) until it is next deployed; the release
  scripts' env-drift check reports `AGORA_APP_CERTIFICATE DIFFERENT` for them — expected. Moving
  `AGORA_APP_CERTIFICATE` and `SG_MAIL_KEY` out of `functions/.env` into Secret Manager secrets declared only by their
  reader functions is a **separate reviewed code change**, not part of this phase.
- **Rollback** (until the old certificate is deleted): put the old value back in `functions/.env`, repeat step 3.
- **Approval line:** "Final phase §3.2 Agora: enable secondary, rot-85 AGORA, delete the old certificate after 7 days."

### 3.3 Service keys — one pair per quiet hour
Pairs: `SERVICE_KEY_WEEKLY_ACCRUAL`↔`ZIPPER_ACCRUAL_KEY`, `SERVICE_KEY_REPORTING`↔`ZIPPER_REPORTING_KEY`,
`SERVICE_KEY_PARTNER_REGISTRATION`↔`ZIPPER_PARTNER_REGISTRATION_KEY`.
1. `./rot-80-backend-secret.command SERVICE_KEY_X pin` — `PIN`, `SHIFT` (no behaviour change).
2. MANUAL: one new value (password manager, ≥ 32 characters) added as a new version to **both** secrets of the pair.
3. `./rot-80-backend-secret.command SERVICE_KEY_X switch` — `NEWREV`, `SHIFT`; immediately after,
   `./rot-85-functions-redeploy.command ZIPPER_X_KEY` — `REDEPLOY`. In between (a few minutes) that pair's machine
   calls get 401, because the backend accepts one key.
4. Verify: the next run of the job(s) — no 401 on `/api/notifications/jobs/*`, `/api/reports/jobs/*`,
   `/api/partner-ops/partners`; for the partner pair, if a sign-up fell into the window run
   `python -m scripts.backfill_partners` (dry run first).
5. After the window: `rot-90` the old version of **both** secrets.
- **Rollback:** fix forward (paste the same value again into the side that differs and rerun that side); `back` alone
  re-opens the mismatch.
- **Approval line:** "Final phase §3.3 <pair>: rot-80 pin, add the version to both secrets, rot-80 switch + rot-85."

### 3.4 `JWT_SECRET`
1. `rot-80 JWT_SECRET pin` — `PIN`, `SHIFT`. 2. MANUAL: new version (≥ 32 random characters).
3. `rot-80 JWT_SECRET switch` — `NEWREV`, `SIGNOUT`: **every API session ends** (CRM, app work screens, Observer,
   MFA-bound sessions); everyone signs in again and Owners pass MFA again. Announce it first.
4. Verify: CRM sign-in with Owner MFA, an app work screen, `/api/health` (80 checks it). 5. After the window: `rot-90`.
- **Rollback:** `rot-80 JWT_SECRET back` — sessions from before the switch are valid again; newer ones end.
- **Approval line:** "Final phase §3.4 JWT_SECRET at <time>, everyone signed out."

### 3.5 `MONGO_URI`
1. `rot-80 MONGO_URI pin`. 2. MANUAL Atlas: create a **new** database user with the same roles (never change the
   current user's password — the serving revision would lose the database at once); add its connection string as a new
   `MONGO_URI` version. 3. `rot-80 MONGO_URI switch` — `NEWREV`, `SHIFT`; verify health, error counts, a CRM money
   page. 4. Update your local `backend/.env` by hand. 5. After the window: Atlas → delete the old user (the real
   revocation), then `rot-90`.
- **Rollback:** `rot-80 MONGO_URI back` while the old user exists.
- **Approval line:** "Final phase §3.5 MONGO_URI with Atlas user <name>."

### 3.6 `OWNER_MFA_ENCRYPTION_KEY` — only by decision (costs a re-enrolment of every Owner and the Observer)
Pinned `:1` (no pin step). The backend holds one Fernet key, so enrolments made under the old key cannot be read.
1. MANUAL: generate a Fernet key (command beside `owner_mfa_encryption_key` in `backend/app/config.py`), paste it
   straight into the console as a new version, close the Terminal window. 2. Schedule it with every Owner and the
   Observer present (with `OWNER_MFA_REQUIRED=true` they are locked out until they re-enrol).
3. `rot-80 OWNER_MFA_ENCRYPTION_KEY switch` — `NEWREV`, `REENROL`. 4. Everyone re-enrols (new TOTP + recovery codes)
   and signs in. 5. **Never destroy a version**; disable the old one only after everyone re-enrolled (`rot-90`).
- **Rollback:** `rot-80 OWNER_MFA_ENCRYPTION_KEY back` (old enrolments work again; newer ones are lost).
- **Approval line:** "Final phase §3.6 Owner MFA key, re-enrolment session at <time>."

### 3.7 Android debug keystore — NOT rotated (accepted risk)
The fleet trusts the debug signature; a new key means `INSTALL_FAILED_UPDATE_INCOMPATIBLE` on every phone (uninstall,
reinstall, guest accounts lost). Mitigations: an encrypted offline backup of `~/.android/debug.keystore`; the Mac
protected (FileVault, account 2SV); every publish checks the debug-CN signer (completion 60) and the updater verifies
each APK's sha256 from `appConfig/androidUpdate`. A key migration (e.g. Play App Signing) is a separate decision.

### 3.8 Firebase web API keys — restrict, not rotated
They ship in every APK and in the CRM bundle. Cloud Console → APIs & Services → Credentials: Android key → *Android
apps* (`com.zipper.app` + the debug certificate SHA-1) and *API restrictions* (only the Firebase APIs used); Browser key
→ *HTTP referrers* (`zipperlive.web.app`, `zipperlive.firebaseapp.com`) and API restrictions. `rot-00` prints
`app=NONE apis=NONE` for an unrestricted key. After each change test sign-in, Firestore, Storage and FCM on APK 20 and
the CRM.

### 3.9 People, owner accounts, service-account keys
`rot-00` prints how many people hold each project role (never who) and the user-managed SA keys (id prefix, dates).
MANUAL: 2-Step Verification on every Google account with a project role; remove stale principals; keep two Owners
(break-glass); app Owners use Owner MFA. For the Admin key file(s) of inventory #10: create a new key in the console,
point the Mac scripts at it, delete the old key.

## 4. Recommended order
`rot-00` → §3.1 SendGrid (now) → §3.2 Agora → §3.3 one pair per quiet hour → §3.4 `JWT_SECRET` (announced) →
§3.5 `MONGO_URI` → §3.6 only if decided → §3.8–3.9 any time → after each window `rot-90` + the issuer-side revocation
→ `rot-00` → delete `FINAL-PHASE-APPROVED`.

## 5. Local test (no production, no approval needed)
`tools/test-rotation-scripts-mac.command` copies this folder into a throwaway git repository with stub
gcloud/firebase/npm/curl/date, network denied by sandbox-exec, and writes `production/test-rotation-<UTC>/SUMMARY.txt`
(expect `N/N PASS`). After any reviewed edit, rerun it and regenerate this folder's hash file:
`shasum -a 256 rot_common.sh rot_helpers.py rot-*.command > SCRIPTS.sha256`.

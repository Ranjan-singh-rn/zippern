# LOCAL-VERIFY — every local build and test of ZIPPER, on the Mac

`LOCAL-VERIFY-mac.command` runs all of the repo's local builds and test suites on this Mac and saves the
evidence to `release/completion-20261101/local-verify-<UTC>/`. It exists for the checks a sandbox cannot run:
the Android Gradle build, the CRM `next build`, the Firestore/Storage emulator suites, and the backend suite
on Python 3.12 with the exact locked dependencies.

**It changes nothing in production.** It deploys nothing, publishes nothing, logs in to nothing, and writes to
no Google or Firebase project. See [Production safety](#production-safety) for how that is enforced.

## How to run

1. Close anything that would collide with it:
   - the CRM dev server (`start-crm-dev.command`), because `npm ci` replaces `zipper-crm/node_modules`;
   - any running Firebase emulator (ports 8080, 9099, 9199, 4400, 4500, 9150);
   - Android Studio builds.
2. Double-click `LOCAL-VERIFY-mac.command` in Finder. If macOS refuses to open it, right-click it and choose
   Open once, or run it in Terminal:
   `bash ~/Documents/Projects/zippern/release/completion-20261101/LOCAL-VERIFY-mac.command`
3. Leave the window open. Every step prints a start line and a result line. Long steps print a `tail -f` command
   for following their log. The Mac is kept awake (`caffeinate`) while the launcher runs.
4. When it finishes, SUMMARY.txt is printed and opened. Ctrl-C stops the run early. A partial SUMMARY.txt is
   still written, with `OVERALL: INCOMPLETE`.

Exit codes: 0 = no step failed, 1 = at least one step failed, 2 = refused to start, 130 = interrupted.

Options (environment variables placed before `bash …`):

| Variable | Effect |
|---|---|
| `ONLY="rules android"` | Run only these step groups. Choose from `git functions backend crm rules android`. |
| `CRM_NPM_CI=0` | Keep the existing `zipper-crm/node_modules` instead of running `npm ci`. |
| `BACKEND_SYNC_LOCK=0` | Leave `backend/.venv` unchanged. If it has drifted from the lock, 3a reports WARN (not the exact deps). |
| `SKIP_INFO=1` | Passed to the hotfix1 runner, which then skips its two info-only suites. |

## What it runs (in order)

Each step has its own log and its own exit code. A failure never stops the run. Times are rough; the first run
is slower because caches are cold. **Total: about 45–90 minutes.**

| Step | What | How | Time |
|---|---|---|---|
| 1 | git HEAD + dirty check | `git rev-parse` / `log -1` / `status --porcelain`, read-only with `--no-optional-locks`. A dirty tree is recorded, never refused. | s |
| 2a | functions `npm ci` | Only if `functions/node_modules` is missing. | 1–2 min |
| 2b | functions `tsc` | `npm run build` | <1 min |
| 2c | functions unit tests | `node --test "test/**/*.test.js"` in a clean environment (`env -i`, temporary HOME), outbound network denied except 127.0.0.1 | 1–3 min |
| 3a | backend venv | `backend/.venv` on Homebrew Python 3.12. Created from `requirements.lock` with `pip install --no-deps` if missing. Brought back to the lock the same way if it differs. Then `pip check`. | 0–2 min |
| 3b | backend tests | Every `backend/tests/test_*.py`, one process per module, the way the SendGrid Mac runner runs them (details in Production safety). | 3–8 min |
| 4a | CRM `npm ci` | Clean install from `package-lock.json` | 1–3 min |
| 4b | CRM typecheck | `npm run typecheck` | ~1 min |
| 4c | CRM tests | `npm test`. If it fails, each spec in its `&&` chain is re-run alone so one failure cannot hide another (`crm-test-each/`). | 2–4 min |
| 4d | CRM build | `npm run build`: `next build`, static export to `zipper-crm/out/`. Needs `zipper-crm/.env.local`; only its key **names** are checked. | 2–5 min |
| 4e | CRM verify:out | `npm run verify:out`: freshness, bundle probes, `out/` tree sha256. Never deployed. | <1 min |
| 5a | rules, hotfix1 | `hotfix/rules-20261101/run-hotfix1-rules-tests.command` (tests the hotfix rule files) | 5–10 min |
| 5b | rules, rc2 | `tests/run-rc2-rules-tests.command`. Only if it exists; otherwise recorded as NOT-PRESENT. | ~5 min |
| 5c | rules, p1mfa | `tests/run-p1mfa-verify.command`: 11 suites against the working-tree rules | 5–10 min |
| 5d | rules, phase1a | `tests/run-phase1a-validation.sh` with only its emulator steps (its Android steps are covered by 6a) | 2–4 min |
| 6a | Android | `./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleProd`, plus `--continue` (a test failure does not block the APKs) and the no-upload init script. JAVA_HOME: yours if set, else the Android Studio JBR, else `/usr/libexec/java_home`. | 10–30 min |
| 6b | prod APKs | For each current APK in `app/build/outputs/apk/prod/`: `apksigner verify --print-certs` (only the certificate CN and SHA-256 are kept) and `aapt dump badging` | <1 min |

## Reading SUMMARY.txt

The header records the environment: tool versions, the Java chosen for the emulators and for Gradle, the SDK
build-tools, whether the network sandbox works, which credential variable **names** were cleared, and the sha256
of the working-tree rules. Below it is a table of STEP / WHAT / RESULT / EXIT / COUNTS, then the log of every
step, any notes, and the OVERALL line.

| RESULT | Meaning |
|---|---|
| PASS | The command exited 0. For 3b, every module exited 0. For 6b, every prod APK passed every check. |
| FAIL | Non-zero exit, or a check failed. Open the step's log. |
| REFUSED | Either the launcher's guard found a production-touching line in that runner, so it was **not run**; or the runner's own preflight stopped (exit 2, for example a missing emulator JAR, Java 21 or `node_modules`). The log says which. |
| WARN | 3a only: `backend/.venv` differs from the lock and `BACKEND_SYNC_LOCK=0` kept it as it is. |
| SKIPPED | Could not run: no Python 3.12 venv, no `.env.local`, or no current prod APK. |
| NOT-PRESENT | 5b: the rc2 runner did not exist at run time. |
| N/A | Not needed (functions `node_modules` already present, or `CRM_NPM_CI=0`). |
| INFO | Step 1, recorded only. |

OVERALL is one of:

- **FAIL**: any step is FAIL or REFUSED.
- **INCOMPLETE**: the run was interrupted.
- **PASS WITH GAPS**: nothing failed, but at least one step is WARN, SKIPPED or NOT-PRESENT.
- **PASS**: every step that ran passed.

What the COUNTS column is parsed from:

- **2b, 4b**: the number of `error TSnnnn` lines.
- **2c**: the `node --test` totals: tests, pass, fail, cancelled, skipped, todo.
- **3a**: the Python version, `LOCK pinned=… installed=… missing=… different=… extra=…`, and the `pip check`
  exit. Exact deps means missing 0 and different 0; `pip` and `bsdiff4` show as harmless extras.
- **3b**: the number of modules that exited 0 and non-zero (non-zero modules are named), the summed
  `All N … checks passed` and `N of M … FAILED` lines, and the number of `NOT RUN` lines.
  Per-module logs are in `backend-modules/`; every module's exit code is in `backend-modules.tsv`.
- **4c**: the summed spec checks, plus the per-spec re-run if the chain failed.
- **4d**: static pages generated, and whether the required `NEXT_PUBLIC_*` key names are present.
- **4e**: verify-out's check count and the `out/` tree sha256. Compare that hash with what is later deployed.
- **5a**: suite verdicts (PASS / FAIL / info-only) and the `HOTFIX1-RUN` line. The check totals include the
  info-only suites and phase1a's allow-listed failures, so trust the verdict, not the totals. A copy of the
  runner's results is in `rules-hotfix1-results/`.
- **5c, 5d**: suites that exited 0 and non-zero, plus the check totals. These test the **working-tree**
  `firestore.rules` / `storage.rules`. A FAIL means the working tree fails that suite; read the runner's own
  notes on suites that target an older lineage. Copies are in `rules-p1mfa/` and `rules-phase1a/`.
- **6a**: JUnit totals from the XML files (copied to `android-unit-xml/`) and the task states:
  - `executed`, or `UP-TO-DATE` / `FROM-CACHE`, which mean Gradle reused the result of an identical earlier
    run;
  - the debug and prod APK counts;
  - how many Crashlytics upload tasks were reported SKIPPED.
- **6b**: per APK, all of these must hold:
  - apksigner exits 0;
  - signer CN is **Android Debug** (prod is signed with the fleet's debug key on purpose; see
    `zipper-app/app/build.gradle.kts`, A-4);
  - package is `com.zipper.app`;
  - versionCode is 20;
  - `application-debuggable` is absent.

  It also records the certificate SHA-256. Compare it with the fleet's known debug-key fingerprint. The full
  badging output is in `android-prod-badging-*.txt`.

## Production safety

- **No deploy, publish or login.** It never runs the Google Cloud CLI, curl/wget, or any git write command.
- **Credentials cleared.** It unsets every credential and project variable before any step:
  `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_TOKEN`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`,
  `CLOUDSDK_CORE_PROJECT`, `FIREBASE_CONFIG`, the SendGrid keys and others. It **refuses to start** (exit 2)
  if any of them is still set afterwards. Only the names are recorded.
- **Emulators only.** Every emulator suite runs inside `firebase emulators:exec` with the `demo-zipper`
  project, which exists only inside the local emulator.
- **Guard.** Before calling a runner (and on itself), the launcher scans it. It does not run a runner that
  contains any of these:
  - a deploy, or a firebase command other than the emulators;
  - gcloud, gsutil, curl, wget, ssh or sudo;
  - a git write;
  - a `--project` that is not `demo-*`;
  - a credential assignment.

  This matters most for `tests/run-rc2-rules-tests.command`, which was still being written when this launcher
  was.
- **Isolated unit tests.** 2c and 3b run with `env -i` and a temporary HOME, so gcloud application-default
  credentials in `~/.config` are invisible. When `sandbox-exec` works, outbound network is also denied except
  to 127.0.0.1.
- **Backend tests never see the real dotenv files.** 3b runs on a throwaway copy of `backend/` that leaves out
  `.env` and `.env.local`, because `app/config.py` would otherwise load them. `.env.example` is kept. The rest
  of the repo is linked read-only, without `.git` or `serviceAccountKey.json`. The copy is deleted at exit.
- **Other secret files.** `zipper-crm/.env.local` is read only by `next build` and by a key-name check; no
  value is printed. `local.properties`, keystores and `google-services.json` are read only by Gradle itself.
- **No Crashlytics upload.** Crashlytics Gradle plugin 3.0.2 would upload the R8 mapping file of the minified
  prod build to the Firebase project in `google-services.json` during `assembleProd`. An init script disables
  every `uploadCrashlytics*` task; it is saved in the evidence folder as `no-firebase-upload.init.gradle`. 6a
  counts those tasks as SKIPPED, and a note appears if one ever runs.
- **Network the Mac does use** (none of it production):
  - the npm registry, for `npm ci`;
  - PyPI, only when `backend/.venv` is created or synced;
  - Google and Maven repositories, for Gradle dependencies that are not yet cached;
  - emulator JAR downloads by the firebase CLI, if they are not cached.

  Next.js telemetry is disabled.

## What it changes locally

- `zipper-crm/node_modules` (`npm ci`), `zipper-crm/.next`, and `zipper-crm/out/`. `out/` is what a hosting
  deploy would ship; 4e prints its tree hash.
- `functions/lib` (tsc). `functions/node_modules` and `tests/node_modules` only if they are missing.
- `backend/.venv`, brought to `requirements.lock`. On 1 Nov 2026 it differs in 22 of 64 packages, for example
  anyio 4.14.2 → 4.15.1 and cryptography 50.0.0 → 50.0.2. Set `BACKEND_SYNC_LOCK=0` to leave it alone.
- `zipper-app/app/build` (APKs, test results).
- The runners' own result folders: `hotfix/rules-20261101/results-<UTC>/`, `outputs/verify/p1mfa-rules-*`,
  `validation-logs/<UTC>-*`.
- The evidence folder `release/completion-20261101/local-verify-<UTC>/`, which is untracked in git.
- Nothing else outside the npm, pip and Gradle caches and a temporary folder that is removed at exit. No git
  write.

## Troubleshooting

| Symptom | Do this |
|---|---|
| macOS will not open the file | Right-click it and choose Open, or run it with `bash` as shown above. |
| 5b REFUSED (launcher guard) | The rc2 runner contains a line the launcher will not run. The COUNTS column names it; review the runner before running it yourself. |
| 5x REFUSED (runner preflight) | The runner is missing something (Java 21, a cached emulator JAR, `tests/node_modules`). Its log says what to install. |
| Note "ports already in use" | Stop the other emulator or server, then re-run with `ONLY=rules`. |
| 3a FAIL, "not 3.12" | Move `backend/.venv` aside. The next run recreates it from `requirements.lock`. |
| 6b FAIL, CN is not "Android Debug" | This Mac's `~/.android/debug.keystore` is not the fleet's key. Do not publish that APK. |
| Re-run one part | For example `ONLY="android" bash …/LOCAL-VERIFY-mac.command` |

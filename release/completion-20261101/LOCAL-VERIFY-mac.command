#!/bin/bash
# LOCAL-VERIFY-mac.command — every LOCAL build and test of the ZIPPER repo, on this Mac, with the evidence kept.
#
# Double-click it in Finder, or run:
#     bash ~/Documents/Projects/zippern/release/completion-20261101/LOCAL-VERIFY-mac.command
# What each result means, how long it takes and what it changes: LOCAL-VERIFY-README.md (same folder).
#
# Steps, in this order. Every step writes its own log and records its own exit code; a failure never stops the run.
#   1    git        HEAD + dirty check — recorded, never refused (read-only git with --no-optional-locks)
#   2a   functions  npm ci — only if functions/node_modules is missing
#   2b   functions  tsc (npm run build)
#   2c   functions  node --test "test/**/*.test.js" — clean environment, temporary HOME, outbound network denied
#   3a   backend    Python 3.12 venv at backend/.venv: created from requirements.lock (pip --no-deps) if missing,
#                   brought back to the lock (pip --no-deps) if it drifted, then pip check  [BACKEND_SYNC_LOCK=0: no sync]
#   3b   backend    every backend/tests/test_*.py module, the way the SendGrid Mac runner runs them: a throwaway copy
#                   of backend/ WITHOUT .env and .env.local, env -i, temporary HOME, outbound network denied except
#                   127.0.0.1 (sandbox-exec, when its probe passes); one exit code per module
#   4a-e crm        npm ci [CRM_NPM_CI=0: skip] -> typecheck -> npm test -> build (next build = static export) -> verify:out
#   5a-d rules      hotfix/rules-20261101/run-hotfix1-rules-tests.command, tests/run-rc2-rules-tests.command (only if
#                   present), tests/run-p1mfa-verify.command, tests/run-phase1a-validation.sh (its emulator steps)
#   6a   android    ./gradlew --no-daemon :app:testDebugUnitTest :app:assembleDebug :app:assembleProd
#                   (+ --continue, so a unit-test failure does not stop the APK builds)
#   6b   android    prod APKs: apksigner verify --print-certs (exit 0; its raw output is kept, never parsed), the signing
#                   certificate read from the APK Signing Block by tools/apk_cert.py (exactly one, CN=Android Debug,
#                   SHA-256 = FLEET_CERT_SHA256 of rel_common.sh) and aapt dump badging (versionCode 20, not debuggable)
#
# Production is never touched:
#   * no deploy, publish, login or Google Cloud CLI; the emulator suites run only under the demo-zipper project,
#     which exists only inside the local emulator;
#   * GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_TOKEN and the other credential / project variables are unset first,
#     and the run REFUSES to start if any of them is still set afterwards;
#   * every runner it calls (and this file) is scanned first and is not run if it contains a deploy, a firebase
#     command other than the emulators, gcloud/gsutil/curl/wget, a git write, a --project other than demo-*,
#     or sets a credential variable;
#   * the Crashlytics Gradle plugin's upload tasks are disabled by an init script — it would otherwise upload the
#     R8 mapping file of the minified prod build to the Firebase project named in google-services.json;
#   * zipper-crm/.env.local is read only by `next build` and by a key-NAME check; no value is ever printed.
# Local changes: build outputs (functions/lib, zipper-crm/.next and out/, zipper-app/app/build), zipper-crm/node_modules
# (npm ci), backend/.venv (brought to requirements.lock), the called runners' own result folders, the evidence folder.
# No git write command is run.
#
# Evidence: release/completion-20261101/local-verify-<UTC>/SUMMARY.txt, logs/, per-step files.
# Exit:     0 = no step failed, 1 = at least one step failed, 2 = refused to start, 130 = interrupted.
# Options:  ONLY="git functions backend crm rules android" (any subset), CRM_NPM_CI=0, BACKEND_SYNC_LOCK=0

set -u
umask 077
export GIT_OPTIONAL_LOCKS=0 NEXT_TELEMETRY_DISABLED=1

HERE="$(cd "$(dirname "$0")" && pwd -P)" || exit 2
REPO="$(cd "$HERE/../.." && pwd -P)" || exit 2
SELF="$HERE/$(basename "$0")"
ONLY="${ONLY:-git functions backend crm rules android}"
EXPECT_VERSION_CODE="${EXPECT_VERSION_CODE:-20}"
TAB="$(printf '\t')"
RC=0; LOG=""; FAILS=0; OUT=""; INTERRUPTED=0; T0=$SECONDS

refuse() { echo "REFUSING TO RUN: $*" >&2; exit 2; }
wants() { case " $ONLY " in *" $1 "*) return 0 ;; esac; return 1; }

for s in $ONLY; do
  case " git functions backend crm rules android " in
    *" $s "*) ;;
    *) refuse "unknown step '$s' in ONLY (known: git functions backend crm rules android)" ;;
  esac
done
for p in firebase.json functions/package.json backend/requirements.lock zipper-crm/package.json zipper-app/gradlew tests/package.json; do
  [ -e "$REPO/$p" ] || refuse "$REPO does not look like the ZIPPER repo ($p is missing)"
done

# ── Guard: never run a file that could reach production — this launcher included ──────────────────────────
G_CLOUD='(^|[^[:alnum:]_.-])(gcloud|gsutil|curl|wget|ssh|scp|sudo)([[:space:]]|$)'  #GUARD
G_FB='(^|[^[:alnum:]_.-])firebase(-tools)?[[:space:]]+(deploy|login|logout|use|init|open|target|(projects|hosting|functions|firestore|database|auth|storage|apps|ext|remoteconfig|appdistribution|crashlytics|apphosting|dataconnect|login|target):[a-z:]+)([^[:alnum:]_:-]|$)'  #GUARD
G_DEPLOY='npm[[:space:]]+run[[:space:]]+deploy|[[:space:]]deploy[[:space:]]+--only'  #GUARD
G_GITW='(^|[^[:alnum:]_.-])git[[:space:]]+(-C[[:space:]]+[^[:space:]]+[[:space:]]+)?(commit|push|reset|checkout|switch|restore|merge|rebase|stash|clean|pull|fetch|tag|add|rm|mv|config|apply|am|cherry-pick|revert|gc|prune|update-ref|update-index)([[:space:]]|$)'  #GUARD
G_CRED='(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN)=[^[:space:]]'  #GUARD
guard_scan() {  #GUARD
  local body="" why=""  #GUARD
  body="$(grep -vE '^[[:space:]]*#|#GUARD$' "$1" 2>/dev/null)"  #GUARD
  printf '%s\n' "$body" | grep -qE "$G_CLOUD" && why="$why gcloud/gsutil/curl/wget/ssh/sudo;"  #GUARD
  printf '%s\n' "$body" | grep -qE "$G_FB" && why="$why a firebase command other than the emulators;"  #GUARD
  printf '%s\n' "$body" | grep -qE "$G_DEPLOY" && why="$why a deploy;"  #GUARD
  printf '%s\n' "$body" | grep -qE "$G_GITW" && why="$why a git write command;"  #GUARD
  printf '%s\n' "$body" | grep -qE "$G_CRED" && why="$why sets a credential variable;"  #GUARD
  printf '%s\n' "$body" | grep -oE -- '--project([[:space:]]+|=)[^[:space:]]+' | grep -vqE -- "--project([[:space:]]+|=)[\"']?demo-" && why="$why a --project other than demo-*;"  #GUARD
  printf '%s' "$why"  #GUARD
}  #GUARD
W="$(guard_scan "$SELF")"
[ -z "$W" ] || refuse "this launcher failed its own guard:$W"

# ── No production credential may reach any step ─────────────────────────────────────────────────────────────
CRED_VARS="GOOGLE_APPLICATION_CREDENTIALS FIREBASE_TOKEN GOOGLE_OAUTH_ACCESS_TOKEN CLOUDSDK_AUTH_ACCESS_TOKEN_FILE CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE GOOGLE_CLOUD_PROJECT GCLOUD_PROJECT CLOUDSDK_CORE_PROJECT FIREBASE_CONFIG SENDGRID_API_KEY ZIPPER_SENDGRID_API_KEY SG_MAIL_KEY"
# Not credentials, but a value left in the shell would change what a runner tests.
STRAY_VARS="FIRESTORE_EMULATOR_HOST FIREBASE_AUTH_EMULATOR_HOST FIREBASE_STORAGE_EMULATOR_HOST STORAGE_EMULATOR_HOST FIREBASE_EMULATOR_HUB ZIPPER_RULES_FILE ZIPPER_STORAGE_RULES_FILE ZIPPER_ENV_FILE STEPS"
CLEARED=""
for v in $CRED_VARS; do
  env | grep -q "^$v=" && CLEARED="$CLEARED $v"
  unset "$v" 2>/dev/null
done
for v in $STRAY_VARS; do unset "$v" 2>/dev/null; done
STILL=""
for v in $CRED_VARS; do env | grep -q "^$v=" && STILL="$STILL $v"; done
[ -z "$STILL" ] || refuse "credential/project variable(s) still set after unset (read-only?):$STILL — open a new Terminal window without them"

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/zipper-local-verify.XXXXXX")" || refuse "mktemp failed"
cleanup() { [ -n "${TMPROOT:-}" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP
mkdir -p "$TMPROOT/home" || refuse "cannot create a temporary HOME"
# Keep the Mac awake while this runs; caffeinate ends by itself when this script ends.
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w $$ >/dev/null 2>&1 & fi

# ── 1. git HEAD + dirty check — captured BEFORE the evidence folder exists, so it is not counted ──────────────
GIT_HEAD="-"; GIT_BRANCH="-"; GIT_TRACKED=0; GIT_UNTRACKED=0; GIT_RC=0
if wants git; then
  {
    echo "# step:     1 git HEAD + dirty check (read-only: rev-parse, log -1, status --porcelain; --no-optional-locks)"
    echo "# started:  $(date -u +%FT%TZ)"
    if command -v git >/dev/null 2>&1; then
      GIT_HEAD="$(git -C "$REPO" --no-optional-locks rev-parse HEAD 2>&1)"; GIT_RC=$?
      GIT_BRANCH="$(git -C "$REPO" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)"
      echo "HEAD:     $GIT_HEAD"
      echo "branch:   ${GIT_BRANCH:--}"
      echo "commit:   $(git -C "$REPO" --no-optional-locks log -1 --format='%h %cI %s' 2>/dev/null)"
      git -C "$REPO" --no-optional-locks status --porcelain=v1 --untracked-files=normal > "$TMPROOT/porcelain.txt" 2>&1 || GIT_RC=$?
      GIT_UNTRACKED="$(grep -c '^??' "$TMPROOT/porcelain.txt")"
      GIT_TRACKED="$(grep -vc '^??' "$TMPROOT/porcelain.txt")"
      echo "dirty:    $GIT_TRACKED tracked path(s) changed, $GIT_UNTRACKED untracked path(s) — recorded only"
      echo "--- git status --porcelain=v1 (paths only) ---"
      cat "$TMPROOT/porcelain.txt"
    else
      echo "git: not found on PATH"; GIT_RC=127
    fi
    echo "# exit=$GIT_RC"
  } > "$TMPROOT/1-git.log" 2>&1
fi

# ── Evidence folder ─────────────────────────────────────────────────────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/local-verify-$STAMP"
while [ -e "$OUT" ]; do sleep 1; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HERE/local-verify-$STAMP"; done
LOGS="$OUT/logs"
mkdir -p "$LOGS" || refuse "cannot create $OUT"
SUMMARY="$OUT/SUMMARY.txt"; STEPS_TSV="$OUT/steps.tsv"; NOTES="$OUT/notes.txt"; ENVF="$OUT/environment.txt"
: > "$STEPS_TSV"; : > "$NOTES"

# ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
elapsed() { local s=$((SECONDS - T0)); printf '%d:%02d:%02d' $((s / 3600)) $((s % 3600 / 60)) $((s % 60)); }
progress() { printf '[%s +%s] %s\n' "$(date +%H:%M:%S)" "$(elapsed)" "$*" | tee -a "$OUT/progress.log"; }
note() { echo "$*" >> "$NOTES"; progress "NOTE: $*"; }
pf() { if [ "$1" = 0 ]; then echo PASS; else echo FAIL; fi; }
rel() { printf '%s' "${1#"$OUT"/}"; }
oneline() { tr '\t\n' '  ' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'; }
count_re() { local n=""; n="$(LC_ALL=C grep -cE "$1" "$2" 2>/dev/null)"; echo "${n:-0}"; }

# "All N … checks passed." and "N of M … FAILED" lines, summed over the given files -> "<passed> <failed>"
sum_checks() {
  LC_ALL=C awk '
    / checks? passed/ { for (i = 1; i < NF; i++) if ($i == "All" && $(i + 1) ~ /^[0-9]+$/) { p += $(i + 1); break } }
    /FAILED/          { for (i = 2; i < NF; i++) if ($i == "of" && $(i - 1) ~ /^[0-9]+$/ && $(i + 1) ~ /^[0-9]+$/) { f += $(i - 1); break } }
    END { printf "%d %d\n", p, f }' "$@" 2>/dev/null
}

record() {   # id, what, result, exit, counts, log
  local c=""
  c="$(printf '%s' "${5:--}" | oneline)"; [ -n "$c" ] || c="-"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:--}" "$c" "${6:--}" >> "$STEPS_TSV"
  progress "$1  $2 -> $3 (exit ${4:--})  $c"
}

run_step() {   # id, name, dir, command... ; sets RC and LOG
  local id="$1" name="$2" dir="$3" t=$SECONDS
  shift 3
  LOG="$LOGS/$id-$name.log"
  progress "$id  $name — running   (follow it: tail -f \"$LOG\")"
  {
    echo "# step:     $id $name"
    echo "# cwd:      $dir"
    echo "# command:  $*"
    echo "# started:  $(date -u +%FT%TZ)"
    echo "# ---------------------------------------------------------------------------"
  } > "$LOG"
  ( cd "$dir" && "$@" ) >> "$LOG" 2>&1
  RC=$?
  {
    echo "# ---------------------------------------------------------------------------"
    echo "# finished: $(date -u +%FT%TZ) ($((SECONDS - t))s)"
    echo "# exit=$RC"
  } >> "$LOG"
}

jmajor() {   # java binary -> major version, 0 if unknown (same parsing as tests/run-phase1a-validation.sh)
  local v=""
  v="$("$1" -version 2>&1 | sed -n 's/.*version "\([^"]*\)".*/\1/p' | head -n 1)"
  case "$v" in
    1.*) echo "$v" | cut -d. -f2 ;;
    "")  echo 0 ;;
    *)   echo "$v" | cut -d. -f1 | cut -d- -f1 | cut -d+ -f1 ;;
  esac
}
ge21() { local m=""; m="$(jmajor "$1")"; case "$m" in ''|*[!0-9]*) return 1 ;; esac; [ "$m" -ge 21 ]; }
jver() { "$1" -version 2>&1 | head -n 1 | oneline; }

task_state() {   # gradle task, log -> executed | UP-TO-DATE | FROM-CACHE | FAILED | SKIPPED | ... | not run
  local l=""
  l="$(LC_ALL=C grep -E "^> Task $1( |\$)" "$2" | tail -n 1)"
  [ -n "$l" ] || { echo "not run"; return; }
  l="$(printf '%s' "${l#> Task $1}" | sed 's/^ *//')"
  echo "${l:-executed}"
}

list_apks() {   # APK folder -> current APKs (output-metadata.json names them; older leftovers are ignored)
  local d="$1" f=""
  if [ -f "$d/output-metadata.json" ]; then
    LC_ALL=C grep -oE '"outputFile"[[:space:]]*:[[:space:]]*"[^"]+"' "$d/output-metadata.json" | sed -E 's/.*"([^"]+)"$/\1/' |
      while IFS= read -r f; do [ -f "$d/$f" ] && echo "$d/$f"; done
  else
    for f in "$d"/*.apk; do [ -f "$f" ] && echo "$f"; done
  fi
}

finish() {
  local id="" what="" res="" rc="" counts="" log="" warn=0 skip=0 failed_ids="" overall=""
  FAILS=0
  while IFS="$TAB" read -r id what res rc counts log; do
    case "$res" in
      FAIL|REFUSED) FAILS=$((FAILS + 1)); failed_ids="$failed_ids $id" ;;
      WARN) warn=$((warn + 1)) ;;
      SKIPPED|NOT-PRESENT) skip=$((skip + 1)) ;;
    esac
  done < "$STEPS_TSV"
  if [ "$FAILS" -gt 0 ]; then overall="FAIL — $FAILS step(s) failed or were refused:$failed_ids"
  elif [ "$INTERRUPTED" = 1 ]; then overall="INCOMPLETE — interrupted before every step ran; nothing failed among the steps that did"
  elif [ "$warn" -gt 0 ] || [ "$skip" -gt 0 ]; then overall="PASS WITH GAPS — nothing failed; $warn warning(s), $skip step(s) skipped or not present"
  else overall="PASS — every step that ran passed"
  fi
  if [ "$INTERRUPTED" = 1 ] && [ "$FAILS" -gt 0 ]; then overall="$overall (and the run was interrupted)"; fi
  {
    echo "ZIPPER LOCAL-VERIFY   $STAMP   finished $(date -u +%FT%TZ) after $(elapsed)"
    echo "steps requested: $ONLY"
    echo ""
    cat "$ENVF" 2>/dev/null
    echo ""
    printf '%-4s %-46s %-11s %-5s %s\n' "STEP" "WHAT" "RESULT" "EXIT" "COUNTS"
    printf '%s\n' "---- ---------------------------------------------- ----------- ----- --------------------------------------------"
    while IFS="$TAB" read -r id what res rc counts log; do
      printf '%-4s %-46s %-11s %-5s %s\n' "$id" "$what" "$res" "$rc" "$counts"
    done < "$STEPS_TSV"
    echo ""
    echo "Logs (relative to this folder):"
    while IFS="$TAB" read -r id what res rc counts log; do
      [ "$log" = "-" ] || printf '  %-4s %s\n' "$id" "$log"
    done < "$STEPS_TSV"
    if [ -s "$NOTES" ]; then echo ""; echo "Notes:"; sed 's/^/  * /' "$NOTES"; fi
    echo ""
    echo "OVERALL: $overall"
    echo ""
    echo "Production: this launcher ran no deploy, publish or login. Emulator suites used the demo-zipper project only,"
    echo "credential variables were cleared first, and the Crashlytics upload tasks of the Android build were disabled."
    echo "Evidence: $OUT"
  } > "$SUMMARY"
}
on_interrupt() { trap - INT TERM HUP; INTERRUPTED=1; echo ""; note "INTERRUPTED at +$(elapsed) — the steps after this point did not run"; finish; cleanup; exit 130; }
trap on_interrupt INT TERM HUP

# ── Environment ─────────────────────────────────────────────────────────────────────────────────────────────
# Java for Gradle: JAVA_HOME if set, else the Android Studio JBR, else /usr/libexec/java_home (work-verify.command).
AJ=""; AJ_SRC="none found"
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME:-}/bin/java" ]; then
  AJ="$JAVA_HOME"; AJ_SRC="JAVA_HOME (already set)"
else
  for c in "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
           "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
           "/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home"; do
    if [ -x "$c/bin/java" ]; then AJ="$c"; AJ_SRC="Android Studio JBR"; break; fi
  done
  if [ -z "$AJ" ] && [ -x /usr/libexec/java_home ]; then
    c="$(/usr/libexec/java_home 2>/dev/null || true)"
    if [ -n "$c" ] && [ -x "$c/bin/java" ]; then AJ="$c"; AJ_SRC="/usr/libexec/java_home (as zipper-app/work-verify.command)"; fi
  fi
fi
# Java for the emulators: they need 21 or newer.
EJ=""; EJ_SRC="none found (the emulators need Java 21+)"
if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME:-}/bin/java" ] && ge21 "$JAVA_HOME/bin/java"; then
  EJ="$JAVA_HOME"; EJ_SRC="JAVA_HOME"
else
  if [ -x /usr/libexec/java_home ]; then
    for spec in 21 21+; do
      c="$(/usr/libexec/java_home -v "$spec" 2>/dev/null || true)"
      if [ -n "$c" ] && [ -x "$c/bin/java" ] && ge21 "$c/bin/java"; then EJ="$c"; EJ_SRC="/usr/libexec/java_home -v $spec"; break; fi
    done
  fi
  if [ -z "$EJ" ] && command -v java >/dev/null 2>&1 && ge21 java; then
    c="$(java -XshowSettings:properties -version 2>&1 | sed -n 's/^[[:space:]]*java\.home = //p' | head -n 1)"
    if [ -n "$c" ] && [ -x "$c/bin/java" ]; then EJ="$c"; EJ_SRC="java on PATH"; fi
  fi
  if [ -z "$EJ" ] && [ -n "$AJ" ] && ge21 "$AJ/bin/java"; then EJ="$AJ"; EJ_SRC="$AJ_SRC"; fi
fi
EMU_ENV=()
[ -n "$EJ" ] && EMU_ENV=("JAVA_HOME=$EJ" "PATH=$EJ/bin:$PATH")

PY312=""
for c in /opt/homebrew/opt/python@3.12/bin/python3.12 /opt/homebrew/bin/python3.12 /usr/local/opt/python@3.12/bin/python3.12 /usr/local/bin/python3.12; do
  if [ -x "$c" ]; then PY312="$c"; break; fi
done
[ -n "$PY312" ] || PY312="$(command -v python3.12 2>/dev/null || true)"

# Android SDK: ANDROID_HOME / ANDROID_SDK_ROOT / the Android Studio default. local.properties is not read here.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
BT=""
for d in "$SDK"/build-tools/*; do [ -x "$d/apksigner" ] && BT="$d"; done

# Outbound network sandbox for the unit-test processes (the SendGrid Mac runner's profile): probe before use.
SB_PROFILE='(version 1) (allow default) (deny network-outbound (remote ip "*:*")) (allow network-outbound (remote ip "localhost:*"))'
JS_OUT='const s=require("net").connect({host:"1.1.1.1",port:443});s.setTimeout(5000);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));'
JS_LO='const n=require("net");const v=n.createServer(c=>c.end());v.listen(0,"127.0.0.1",()=>{const c=n.connect(v.address().port,"127.0.0.1",()=>{console.log("ok");process.exit(0)});c.on("error",()=>process.exit(1))});'
SB=(); SB_NOTE="NOT sandboxed (no sandbox-exec, or its probe failed): the tests rely on env -i, a temporary HOME and their own stand-ins"
if command -v sandbox-exec >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  if sandbox-exec -p "$SB_PROFILE" node -e 'console.log("ok")' 2>/dev/null | grep -qx ok \
     && ! sandbox-exec -p "$SB_PROFILE" node -e "$JS_OUT" >/dev/null 2>&1 \
     && sandbox-exec -p "$SB_PROFILE" node -e "$JS_LO" 2>/dev/null | grep -qx ok; then
    SB=(sandbox-exec -p "$SB_PROFILE")
    SB_NOTE="outbound network DENIED except 127.0.0.1 (sandbox-exec probes passed)"
  fi
fi

NODE_V="$(node -v 2>/dev/null | head -n 1)"; [ -n "$NODE_V" ] || NODE_V="not found"
NPM_V="$(npm -v 2>/dev/null | head -n 1)"; [ -n "$NPM_V" ] || NPM_V="not found"
FB_V="$(firebase --version 2>/dev/null | head -n 1)"; [ -n "$FB_V" ] || FB_V="not found"
{
  echo "repo:              $REPO"
  if wants git; then echo "git:               HEAD $GIT_HEAD ($GIT_BRANCH); $GIT_TRACKED tracked path(s) changed, $GIT_UNTRACKED untracked"; fi
  echo "launcher sha256:   $(shasum -a 256 "$SELF" | cut -c1-64)"
  echo "machine:           $(sw_vers -productVersion 2>/dev/null || uname -sr) $(uname -m)"
  echo "node / npm:        $NODE_V / $NPM_V"
  echo "firebase CLI:      $FB_V (emulator suites only, project demo-zipper)"
  if [ -n "$EJ" ]; then echo "java, emulators:   $EJ — $(jver "$EJ/bin/java")  [$EJ_SRC]"; else echo "java, emulators:   $EJ_SRC"; fi
  if [ -n "$AJ" ]; then echo "java, Gradle:      $AJ — $(jver "$AJ/bin/java")  [$AJ_SRC]"; else echo "java, Gradle:      none found"; fi
  echo "python 3.12:       ${PY312:-not found}"
  echo "Android SDK:       $SDK (build-tools with apksigner: ${BT:-none})"
  echo "test network:      $SB_NOTE"
  echo "credentials:       cleared at start (names only):${CLEARED:- none were set}"
  echo "working-tree rules: firestore.rules $(shasum -a 256 "$REPO/firestore.rules" | cut -c1-16)…, storage.rules $(shasum -a 256 "$REPO/storage.rules" | cut -c1-16)… (5c/5d; 5a tests hotfix/rules-20261101/)"
} > "$ENVF"

progress "ZIPPER LOCAL-VERIFY $STAMP — steps: $ONLY"
progress "evidence: $OUT"
progress "this usually takes 45-90 minutes; Ctrl-C stops it and still writes a partial SUMMARY.txt"
sed 's/^/      /' "$ENVF"

# ── 1. git ──────────────────────────────────────────────────────────────────────────────────────────────────
if wants git; then
  cp "$TMPROOT/1-git.log" "$LOGS/1-git.log"
  if [ "$GIT_RC" = 0 ]; then
    record 1 "git HEAD + dirty check" INFO 0 "HEAD $(printf '%.12s' "$GIT_HEAD") ($GIT_BRANCH); $GIT_TRACKED tracked path(s) changed, $GIT_UNTRACKED untracked (recorded, not refused)" "logs/1-git.log"
  else
    record 1 "git HEAD + dirty check" INFO "$GIT_RC" "git could not read the repository (see the log); not refused" "logs/1-git.log"
  fi
fi

# ── 2. Cloud Functions: npm ci (if missing) -> tsc -> node --test ─────────────────────────────────────────────
if wants functions; then
  FN="$REPO/functions"
  if [ -d "$FN/node_modules" ]; then
    record 2a "functions: npm ci (if node_modules missing)" N/A - "node_modules present — not reinstalled" -
  else
    run_step 2a functions-npm-ci "$FN" npm ci --no-audit --no-fund --prefer-offline
    record 2a "functions: npm ci (if node_modules missing)" "$(pf "$RC")" "$RC" "installed from functions/package-lock.json" "$(rel "$LOG")"
  fi
  run_step 2b functions-tsc "$FN" npm run build
  record 2b "functions: tsc" "$(pf "$RC")" "$RC" "TypeScript errors: $(count_re 'error TS[0-9]+' "$LOG")" "$(rel "$LOG")"
  FN_ENV=(env -i "PATH=$PATH" "HOME=$TMPROOT/home" "LANG=${LANG:-en_US.UTF-8}")
  [ -n "${TZ:-}" ] && FN_ENV+=("TZ=$TZ")
  run_step 2c functions-node-test "$FN" "${FN_ENV[@]}" "${SB[@]+"${SB[@]}"}" node --test "test/**/*.test.js"
  c=""
  for k in tests pass fail cancelled skipped todo; do
    v="$(LC_ALL=C sed -nE "s/^[^[:alnum:]]*$k ([0-9]+)[[:space:]]*\$/\1/p" "$LOG" | tail -n 1)"
    c="$c$k ${v:-?}, "
  done
  record 2c "functions: node --test" "$(pf "$RC")" "$RC" "${c%, }" "$(rel "$LOG")"
fi

# ── 3. Backend: Python 3.12 venv on requirements.lock -> every tests/test_*.py module ─────────────────────────
BE="$REPO/backend"; VENV="$BE/.venv"; VPY="$VENV/bin/python"; LOCK="$BE/requirements.lock"

lock_compare() {   # installed distributions vs requirements.lock; exit 0 = exact
  "$VPY" -I - "$LOCK" <<'PY'
import re, sys, importlib.metadata as md
norm = lambda n: re.sub(r"[-_.]+", "-", n or "").lower()
want = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if "==" in line:
        name, ver = line.split("==", 1)
        want[norm(name)] = ver.split(";")[0].strip()
have = {norm(d.metadata["Name"]): d.version for d in md.distributions()}
missing = sorted(n for n in want if n not in have)
wrong = sorted("%s %s (lock %s)" % (n, have[n], want[n]) for n in want if n in have and have[n] != want[n])
extra = sorted("%s==%s" % (n, have[n]) for n in have if n not in want)
print("LOCK pinned=%d installed=%d missing=%d different=%d extra=%d" % (len(want), len(have), len(missing), len(wrong), len(extra)))
for k, v in (("missing", missing), ("different", wrong), ("extra (not in the lock)", extra)):
    print("  %s: %s" % (k, ", ".join(v) or "none"))
sys.exit(0 if not missing and not wrong else 1)
PY
}

backend_venv() {   # exit 0 exact + pip check ok | 3 no 3.12 / venv failed | 4 install failed | 5 not 3.12 | 6 pip check | 7 drift
  local ver="" drift=0 pc=0
  if [ ! -x "$VPY" ]; then
    if [ -z "$PY312" ]; then echo "NO-PYTHON312: no Homebrew python@3.12 and no python3.12 on PATH"; return 3; fi
    echo "== backend/.venv is missing: $PY312 -m venv backend/.venv"
    "$PY312" -m venv "$VENV" || return 3
    echo "CREATED backend/.venv"
    echo "== pip install --no-deps -r requirements.lock (exactly as backend/Dockerfile)"
    "$VPY" -m pip --isolated --disable-pip-version-check install --no-deps -r "$LOCK" || return 4
  fi
  ver="$("$VPY" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>&1)"
  echo "VENV-PYTHON $ver"
  case "$ver" in
    3.12.*) ;;
    *) echo "NOT-312: backend/.venv runs Python $ver, not 3.12 — move it aside and run again to recreate it from requirements.lock"; return 5 ;;
  esac
  lock_compare; drift=$?
  if [ "$drift" != 0 ]; then
    if [ "${BACKEND_SYNC_LOCK:-1}" = 0 ]; then
      echo "DRIFT-KEPT: BACKEND_SYNC_LOCK=0 — backend/.venv left as it is; the backend results are NOT on the exact dependency set"
    else
      echo "== backend/.venv differs from requirements.lock: pip install --no-deps -r requirements.lock (only pinned versions change)"
      "$VPY" -m pip --isolated --disable-pip-version-check install --no-deps -r "$LOCK"
      echo "SYNC exit=$?"
      lock_compare; drift=$?
    fi
  fi
  echo "== pip check"
  "$VPY" -m pip --isolated --disable-pip-version-check check; pc=$?
  echo "PIPCHECK exit=$pc"
  [ "$pc" = 0 ] || return 6
  [ "$drift" = 0 ] || return 7
  return 0
}

backend_tests() {   # the SendGrid Mac runner's method, on this working tree
  local W="$TMPROOT/repo" BLOG="$LOGS/3b-backend-tests.log" MOD="$OUT/backend-modules" TSV="$OUT/backend-modules.tsv"
  local e="" n="" t="" m="" rc=0 i=0 total=0 n_mod=0 n_ok=0 p="" f="" nr="" bad="" res="" t1=$SECONDS
  mkdir -p "$W/backend" "$MOD"; : > "$TSV"
  # The rest of the repo, linked read-through (the tests read rules, functions/, zipper-crm/, zipper-app/, docs).
  for e in "$REPO"/* "$REPO"/.[!.]*; do
    [ -e "$e" ] || continue
    n="$(basename "$e")"
    case "$n" in backend|.git|.env|.env.*|serviceAccountKey.json|*.jks) continue ;; esac
    ln -s "$e" "$W/$n"
  done
  # backend/ itself: a real copy WITHOUT the dotenv files app/config.py would load (.env.local, .env).
  for e in "$BE"/* "$BE"/.[!.]*; do
    [ -e "$e" ] || continue
    n="$(basename "$e")"
    case "$n" in
      .env.example) ;;
      .env|.env.*|.venv|__pycache__|.pytest_cache|.DS_Store) continue ;;
    esac
    cp -R "$e" "$W/backend/$n"
  done
  find "$W/backend" -name __pycache__ -type d -prune -exec rm -rf {} +
  ln -s "$VENV" "$W/backend/.venv"
  {
    echo "# step:        3b backend — every tests/test_*.py module (the SendGrid Mac runner's method)"
    echo "# copy:        backend/ without .env, .env.local or any other .env.* except .env.example; .venv -> backend/.venv;"
    echo "#              __pycache__ removed; the rest of the repo linked read-through (no .git, no serviceAccountKey.json)"
    echo "# environment: env -i PATH=/usr/bin:/bin HOME=<temporary> TZ=UTC LANG=en_US.UTF-8 PYTHONDONTWRITEBYTECODE=1"
    echo "# network:     $SB_NOTE"
    echo "# interpreter: $VPY — $("$VPY" -c 'import sys, platform; print(sys.version.split()[0], platform.platform())' 2>&1 | oneline)"
    echo "# started:     $(date -u +%FT%TZ)"
  } > "$BLOG"
  for t in "$W"/backend/tests/test_*.py; do [ -f "$t" ] && total=$((total + 1)); done
  progress "3b  backend-tests — $total modules   (per-module logs: $MOD)"
  for t in "$W"/backend/tests/test_*.py; do
    [ -f "$t" ] || continue
    i=$((i + 1)); m="$(basename "$t" .py)"
    ( cd "$W/backend" && env -i PATH=/usr/bin:/bin HOME="$TMPROOT/home" TZ=UTC LANG=en_US.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
        "${SB[@]+"${SB[@]}"}" "$VPY" -B -m "tests.$m" ) > "$MOD/$m.log" 2>&1
    rc=$?
    printf '%s\t%s\n' "$m" "$rc" >> "$TSV"
    printf '      %3d/%d  %-54s exit %s\n' "$i" "$total" "$m" "$rc"
  done
  n_mod="$(grep -c . "$TSV")"
  n_ok="$(awk -F'\t' '$2 == "0"' "$TSV" | grep -c .)"
  read -r p f <<EOF
$(sum_checks "$MOD"/*.log)
EOF
  nr="$(cat "$MOD"/*.log 2>/dev/null | LC_ALL=C grep -c 'NOT RUN')"
  bad="$(awk -F'\t' '$2 != "0" {printf " %s(exit %s)", $1, $2}' "$TSV")"
  {
    echo "--- exit code per module (also in backend-modules.tsv) ---"
    cat "$TSV"
    echo "--- modules $n_mod | exit 0: $n_ok | non-zero: $((n_mod - n_ok)) | checks passed ${p:-0}, failed ${f:-0} | NOT RUN lines ${nr:-0}"
    echo "# finished: $(date -u +%FT%TZ) ($((SECONDS - t1))s)"
  } >> "$BLOG"
  if [ "$n_mod" -gt 0 ] && [ "$n_ok" = "$n_mod" ]; then res=PASS; else res=FAIL; fi
  record 3b "backend: every tests/test_*.py module" "$res" "$([ "$res" = PASS ] && echo 0 || echo 1)" \
    "modules $n_mod: $n_ok exit 0, $((n_mod - n_ok)) non-zero${bad:+ —$bad}; checks ${p:-0} passed, ${f:-0} failed; NOT RUN lines ${nr:-0}" "$(rel "$BLOG")"
}

if wants backend; then
  run_step 3a backend-venv "$BE" backend_venv
  V_RC=$RC; V_LOG=$LOG
  case "$V_RC" in
    0) res=PASS ;;
    7) if [ "${BACKEND_SYNC_LOCK:-1}" = 0 ]; then res=WARN; else res=FAIL; fi ;;
    *) res=FAIL ;;
  esac
  c="Python $(sed -n 's/^VENV-PYTHON //p' "$V_LOG" | tail -n 1)"
  grep -q '^CREATED' "$V_LOG" && c="$c; created from requirements.lock"
  grep -q '^SYNC exit=' "$V_LOG" && c="$c; brought to the lock (pip $(sed -n 's/^SYNC //p' "$V_LOG" | tail -n 1))"
  grep -q '^DRIFT-KEPT' "$V_LOG" && c="$c; drift kept (BACKEND_SYNC_LOCK=0): NOT the exact dependency set"
  c="$c; $(sed -n 's/^LOCK //p' "$V_LOG" | tail -n 1); pip check $(sed -n 's/^PIPCHECK //p' "$V_LOG" | tail -n 1)"
  grep -q '^NOT-312' "$V_LOG" && c="$(sed -n 's/^NOT-312: //p' "$V_LOG" | head -n 1)"
  grep -q '^NO-PYTHON312' "$V_LOG" && c="no Homebrew python@3.12 / python3.12 found (brew install python@3.12, then run again)"
  record 3a "backend: Python 3.12 venv + lock + pip check" "$res" "$V_RC" "$c" "$(rel "$V_LOG")"
  if [ "$V_RC" = 3 ] || [ "$V_RC" = 5 ] || [ ! -x "$VPY" ]; then
    record 3b "backend: every tests/test_*.py module" SKIPPED - "no Python 3.12 venv (see 3a)" -
  else
    backend_tests
  fi
fi

# ── 4. CRM: npm ci -> typecheck -> npm test -> build -> verify:out (never deployed) ────────────────────────────
CRM="$REPO/zipper-crm"

crm_tests() {
  local t_rc=0 t_log="" p="" f="" ok="" c="" names="" s="" each_n=0 each_ok=0 each_bad=""
  run_step 4c crm-test "$CRM" npm test
  t_rc=$RC; t_log=$LOG
  read -r p f <<EOF
$(sum_checks "$t_log")
EOF
  ok="$(count_re 'All [0-9]+ .*checks? passed' "$t_log")"
  c="specs reporting 'All N … checks passed': $ok; checks ${p:-0} passed, ${f:-0} failed"
  if [ "$t_rc" != 0 ]; then
    # `npm test` is an && chain and stops at the first failing spec: run each one alone so none is hidden.
    mkdir -p "$OUT/crm-test-each"
    names="$(cd "$CRM" && node -e 'var s=(require("./package.json").scripts||{}).test||"";var m=s.match(/npm run [A-Za-z0-9:_-]+/g)||[];console.log(m.map(function(x){return x.slice(8)}).join("\n"))' 2>/dev/null)"
    for s in $names; do
      each_n=$((each_n + 1))
      if ( cd "$CRM" && npm run "$s" ) > "$OUT/crm-test-each/${s//:/-}.log" 2>&1; then
        each_ok=$((each_ok + 1))
      else
        each_bad="$each_bad $s"
      fi
    done
    c="$c; npm test stops at the first failure, so each spec was re-run alone: $each_ok of $each_n pass, failing:${each_bad:- none} (crm-test-each/)"
  fi
  record 4c "CRM: npm test (all specs + hooks lint)" "$(pf "$t_rc")" "$t_rc" "$c" "$(rel "$t_log")"
}

if wants crm; then
  if [ "${CRM_NPM_CI:-1}" = 0 ]; then
    record 4a "CRM: npm ci" N/A - "CRM_NPM_CI=0 — the existing node_modules was kept" -
  else
    run_step 4a crm-npm-ci "$CRM" npm ci --no-audit --no-fund --prefer-offline
    record 4a "CRM: npm ci" "$(pf "$RC")" "$RC" "clean install from package-lock.json; $(LC_ALL=C grep -E '^added [0-9]+ packages' "$LOG" | tail -n 1 | oneline)" "$(rel "$LOG")"
  fi
  run_step 4b crm-typecheck "$CRM" npm run typecheck
  record 4b "CRM: typecheck (tsc --noEmit)" "$(pf "$RC")" "$RC" "TypeScript errors: $(count_re 'error TS[0-9]+' "$LOG")" "$(rel "$LOG")"
  crm_tests
  if [ -f "$CRM/.env.local" ]; then
    # Key NAMES only, as deploy-crm.command checks them; no value is read out or printed.
    missing=""
    for key in NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN NEXT_PUBLIC_FIREBASE_PROJECT_ID NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET NEXT_PUBLIC_FIREBASE_APP_ID NEXT_PUBLIC_OBSERVER_EMAIL; do
      grep -Eq "^[[:space:]]*$key=[^[:space:]]+" "$CRM/.env.local" 2>/dev/null || missing="$missing $key"
    done
    if [ -n "$missing" ]; then
      keys="MISSING:$missing"
      note "zipper-crm/.env.local lacks (names only):$missing — deploy-crm.command requires them"
    else
      keys="all required NEXT_PUBLIC_* names present (values not shown)"
    fi
    run_step 4d crm-build "$CRM" npm run build
    pages="$(LC_ALL=C grep -oE 'Generating static pages \([0-9]+/[0-9]+\)' "$LOG" | tail -n 1 | sed 's/Generating static pages //')"
    record 4d "CRM: build (next build, static export)" "$(pf "$RC")" "$RC" "static pages ${pages:-?}; .env.local: $keys" "$(rel "$LOG")"
    run_step 4e crm-verify-out "$CRM" npm run verify:out
    read -r p f <<EOF
$(sum_checks "$LOG")
EOF
    tree="$(sed -n 's/.*out\/ tree sha256[[:space:]]*:[[:space:]]*//p' "$LOG" | tail -n 1)"
    record 4e "CRM: verify:out" "$(pf "$RC")" "$RC" "checks ${p:-0} passed, ${f:-0} failed; out/ tree sha256 ${tree:-?}" "$(rel "$LOG")"
  else
    record 4d "CRM: build (next build, static export)" SKIPPED - "zipper-crm/.env.local is missing — the build needs its NEXT_PUBLIC_* values" -
    record 4e "CRM: verify:out" SKIPPED - "no build" -
  fi
fi

# ── 5. Rules on the LOCAL emulators (project demo-zipper), through the existing runners ───────────────────────
run_runner() {   # id, name, what, file, kind (hotfix | rc2 | p1mfa | phase1a)
  local id="$1" name="$2" what="$3" f="$4" kind="$5" why="" res="" c="" p="" fl="" ok_="" bad_="" info_="" d="" st=""
  if [ ! -f "$f" ]; then record "$id" "$what" NOT-PRESENT - "not present: ${f#"$REPO"/}" -; return; fi
  why="$(guard_scan "$f")"
  if [ -n "$why" ]; then record "$id" "$what" REFUSED - "NOT RUN — the launcher's guard found:$why" -; return; fi
  if [ "$kind" = phase1a ]; then
    run_step "$id" "$name" "$REPO" env "${EMU_ENV[@]+"${EMU_ENV[@]}"}" STEPS="environment rules-firestore rules-phase1a rules-storage" bash "$f"
  else
    run_step "$id" "$name" "$REPO" env "${EMU_ENV[@]+"${EMU_ENV[@]}"}" bash "$f"
  fi
  case "$RC" in 0) res=PASS ;; 2) res=REFUSED ;; *) res=FAIL ;; esac
  case "$kind" in
    hotfix)
      ok_="$(count_re '^[A-Za-z0-9:_.-]+ exit=[0-9]+.* PASS$' "$LOG")"
      bad_="$(count_re '^[A-Za-z0-9:_.-]+ exit=[0-9]+.* FAIL$' "$LOG")"
      info_="$(count_re '^[A-Za-z0-9:_.-]+ exit=[0-9]+ .*info only' "$LOG")"
      read -r p fl <<EOF
$(sum_checks "$LOG")
EOF
      c="suites: $ok_ PASS, $bad_ FAIL, $info_ info-only; checks ${p:-0} passed, ${fl:-0} failed (counts include the info-only suites and phase1a's allow-listed failures); $(grep -E '^HOTFIX1-RUN:' "$LOG" | tail -n 1)"
      d="$(sed -n 's/^Results: //p' "$LOG" | tail -n 1)"
      if [ -n "$d" ] && [ -d "$d" ]; then cp -R "$d" "$OUT/rules-hotfix1-results"; fi
      ;;
    p1mfa)
      # Its suite lines appear twice (live, then in its result-line digest): count each suite once.
      ok_="$(LC_ALL=C grep -E '^[A-Za-z0-9:_.-]+ exit=[0-9]+$' "$LOG" | sort -u | grep -c ' exit=0$')"
      bad_="$(LC_ALL=C grep -E '^[A-Za-z0-9:_.-]+ exit=[0-9]+$' "$LOG" | sort -u | grep -vc ' exit=0$')"
      read -r p fl <<EOF
$(sum_checks "$LOG")
EOF
      c="suites: $ok_ exit 0, $bad_ non-zero; checks ${p:-0} passed, ${fl:-0} failed"
      d="$(sed -n 's/^Full log: //p' "$LOG" | tail -n 1)"
      if [ -n "$d" ] && [ -f "$REPO/$d" ]; then mkdir -p "$OUT/rules-p1mfa"; cp "$REPO/$d" "$REPO/$d.summary" "$OUT/rules-p1mfa/" 2>/dev/null; fi
      ;;
    phase1a)
      st="$(sed -n 's/^Phase 1A validation run //p' "$LOG" | head -n 1)"
      if [ -n "$st" ]; then mkdir -p "$OUT/rules-phase1a"; cp "$REPO/validation-logs/$st"-* "$OUT/rules-phase1a/" 2>/dev/null; fi
      ok_="$(count_re '^rules-[a-z0-9]+ +exit=0 ' "$LOG")"
      bad_="$(count_re '^rules-[a-z0-9]+ +exit=[1-9]' "$LOG")"
      read -r p fl <<EOF
$(sum_checks "$OUT/rules-phase1a/$st"-rules-*.log)
EOF
      c="suites: $ok_ exit 0, $bad_ non-zero; checks ${p:-0} passed, ${fl:-0} failed"
      [ "$RC" = 2 ] && c="$c; its preflight stopped: $(grep -m 1 -E 'MISSING|STOPPED' "$LOG" | oneline)"
      ;;
    *)
      ok_="$(LC_ALL=C grep -E '^[A-Za-z0-9:_.-]+ exit=[0-9]+' "$LOG" | sort -u | grep -cE ' exit=0([^0-9]|$)')"
      bad_="$(LC_ALL=C grep -E '^[A-Za-z0-9:_.-]+ exit=[1-9]' "$LOG" | sort -u | grep -c .)"
      read -r p fl <<EOF
$(sum_checks "$LOG")
EOF
      c="suite lines: $ok_ exit 0, $bad_ non-zero; checks ${p:-0} passed, ${fl:-0} failed; $(LC_ALL=C grep -E 'RESULT|-RUN:' "$LOG" | tail -n 1 | oneline)"
      d="$(sed -n 's/^Results: //p' "$LOG" | tail -n 1)"
      if [ -n "$d" ] && [ -d "$d" ]; then cp -R "$d" "$OUT/rules-$kind-results"; fi
      ;;
  esac
  [ "$res" = REFUSED ] && c="the runner's own preflight refused (exit 2): $(grep -m 1 -E 'REFUSING|STOPPED|MISSING' "$LOG" | oneline); $c"
  record "$id" "$what" "$res" "$RC" "$c" "$(rel "$LOG")"
}

if wants rules; then
  [ -n "$EJ" ] || note "no Java 21+ found for the emulators; the rules runners will report it"
  busy=""
  if command -v lsof >/dev/null 2>&1; then
    for port in 8080 9099 9199 4400 4500 9150; do
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && busy="$busy $port"
    done
  fi
  [ -z "$busy" ] || note "emulator port(s) already in use:$busy — stop the other emulator/server, then re-run with ONLY=rules"
  if [ ! -d "$REPO/tests/node_modules" ]; then
    run_step 5 tests-npm-ci "$REPO/tests" npm ci --no-audit --no-fund --prefer-offline
    record 5 "rules: tests/ npm ci (node_modules missing)" "$(pf "$RC")" "$RC" "installed from tests/package-lock.json" "$(rel "$LOG")"
  fi
  run_runner 5a rules-hotfix1 "rules: hotfix1 runner (hotfix/rules-20261101)" "$REPO/hotfix/rules-20261101/run-hotfix1-rules-tests.command" hotfix
  run_runner 5b rules-rc2 "rules: rc2 runner" "$REPO/tests/run-rc2-rules-tests.command" rc2
  run_runner 5c rules-p1mfa "rules: p1mfa-verify runner (working tree)" "$REPO/tests/run-p1mfa-verify.command" p1mfa
  run_runner 5d rules-phase1a "rules: phase1a runner, emulator steps" "$REPO/tests/run-phase1a-validation.sh" phase1a
fi

# ── 6. Android: unit tests + debug + prod, then the prod APKs' signer and badging ─────────────────────────────
APP="$REPO/zipper-app"
PROD_APKS=""

badging() {   # apk -> aapt dump badging (aapt2 if aapt is missing or fails)
  if [ -x "$BT/aapt" ] && "$BT/aapt" dump badging "$1" 2>&1; then return 0; fi
  if [ -x "$BT/aapt2" ]; then "$BT/aapt2" dump badging "$1" 2>&1; return $?; fi
  echo "no usable aapt or aapt2 in $BT"; return 127
}

cert_field() {   # tools/apk_cert.py line, \1 SCHEMES | \2 CERTS | \3 SHA256 | \4 CN -> that field (nothing if not such a line)
  printf '%s\n' "$1" | LC_ALL=C sed -n "s/^APK [^ ]* SCHEMES \([^ ]*\) CERTS \([0-9]*\) SHA256 \([^ ]*\) CN \(.*\)\$/$2/p" | head -n 1
}

verify_prod_apks() {
  local plog="$LOGS/6b-android-prod-apk.log" apk="" n=0 good=0 src=0 crc=0 line="" abi="" sfile="" errs="" bfile="" pkg=""
  local schemes="" ncert="" sha="" cn="" pname="" vcode="" vname="" dbg=0 ok=0 fleet="" srcs="" vcs="" ncs="" cns="" shas="" dbgs="" res="" c=""
  # The fleet's certificate, from its one source of truth: FLEET_CERT_SHA256 in rel_common.sh (read here, never sourced).
  fleet="$(LC_ALL=C sed -n 's/^FLEET_CERT_SHA256="\([0-9a-f]\{64\}\)".*/\1/p' "$HERE/rel_common.sh" 2>/dev/null | head -n 1)"
  {
    echo "# step:     6b prod APK checks"
    echo "# tools:    $BT/apksigner verify --print-certs   signature validity = its exit code; its output is kept, never parsed"
    echo "#           tools/apk_cert.py                     the signing certificate(s), read from the APK Signing Block"
    echo "#           $BT/aapt dump badging   (aapt2 if aapt is unusable)"
    echo "# kept:     apksigner's raw output as android-prod-apksigner-<abi>.txt (public certificate data only); nothing about any keystore"
    echo "# expected: apksigner exit 0; exactly one signing certificate, CN=Android Debug, SHA-256 = FLEET_CERT_SHA256 of rel_common.sh"
    echo "#           (${fleet:-NOT FOUND}: the key that signed APK 19 — any other key and every phone refuses the update);"
    echo "#           package com.zipper.app, versionCode $EXPECT_VERSION_CODE, no application-debuggable"
    echo "#           (the prod build type is signed with the debug key on purpose: zipper-app/app/build.gradle.kts, A-4)"
    echo "# started:  $(date -u +%FT%TZ)"
  } > "$plog"
  while IFS= read -r apk; do
    [ -n "$apk" ] || continue
    n=$((n + 1))
    abi="$(basename "$apk" .apk)"; abi="${abi#app-}"; abi="${abi%-prod}"
    sfile="$OUT/android-prod-apksigner-$abi.txt"
    ( JAVA_HOME="$AJ"; PATH="$AJ/bin:$PATH"; export JAVA_HOME PATH; "$BT/apksigner" verify --print-certs "$apk" ) > "$sfile" 2>&1
    src=$?
    errs="$(LC_ALL=C grep -E '^(ERROR|DOES NOT VERIFY)' "$sfile" | head -n 3 | oneline)"
    line="$(python3 -I "$HERE/tools/apk_cert.py" "$apk" 2>&1)"
    crc=$?
    schemes="$(cert_field "$line" '\1')"; ncert="$(cert_field "$line" '\2')"; sha="$(cert_field "$line" '\3')"; cn="$(cert_field "$line" '\4')"
    bfile="$OUT/android-prod-badging-$(basename "$apk" .apk).txt"
    badging "$apk" > "$bfile" 2>&1
    pkg="$(LC_ALL=C grep -m 1 '^package:' "$bfile")"
    pname="$(printf '%s' "$pkg" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")"
    vcode="$(printf '%s' "$pkg" | sed -n "s/.*[[:space:]]versionCode='\([^']*\)'.*/\1/p")"
    vname="$(printf '%s' "$pkg" | sed -n "s/.*[[:space:]]versionName='\([^']*\)'.*/\1/p")"
    dbg="$(count_re '^application-debuggable' "$bfile")"
    ok=1
    [ "$src" = 0 ] || ok=0
    [ "$crc" = 0 ] || ok=0
    [ "$ncert" = 1 ] || ok=0
    [ "$cn" = "Android Debug" ] || ok=0
    [ -n "$fleet" ] && [ "$sha" = "$fleet" ] || ok=0
    [ "$pname" = "com.zipper.app" ] || ok=0
    [ "$vcode" = "$EXPECT_VERSION_CODE" ] || ok=0
    [ "$dbg" = 0 ] || ok=0
    [ "$ok" = 1 ] && good=$((good + 1))
    srcs="$srcs $src"; vcs="$vcs ${vcode:-none}"; ncs="$ncs ${ncert:-none}"; cns="$cns|${cn:-none}"; shas="$shas ${sha:-none}"
    dbgs="$dbgs $([ "$dbg" = 0 ] && echo absent || echo PRESENT)"
    {
      echo ""
      echo "== $(basename "$apk")   $(wc -c < "$apk" | tr -d ' ') bytes   sha256 $(shasum -a 256 "$apk" | cut -c1-64)"
      echo "   apksigner verify:        exit $src${errs:+   $errs}   (output: $(rel "$sfile"))"
      [ -n "$ncert" ] || echo "   tools/apk_cert.py:       exit $crc   $(printf '%s' "$line" | oneline)"
      echo "   signature schemes:       ${schemes:-none}"
      echo "   signing certificates:    ${ncert:-0}"
      echo "   certificate CN:          ${cn:-?}"
      echo "   certificate SHA-256:     ${sha:-?}   $(if [ -n "$fleet" ] && [ "$sha" = "$fleet" ]; then echo "= FLEET_CERT_SHA256"; else echo "NOT the fleet's certificate"; fi)"
      echo "   package:                 ${pname:-?}   versionCode=${vcode:-?}   versionName=${vname:-?}"
      echo "   application-debuggable:  $([ "$dbg" = 0 ] && echo absent || echo PRESENT)"
      echo "   verdict:                 $([ "$ok" = 1 ] && echo PASS || echo FAIL)"
    } >> "$plog"
  done <<EOF
$PROD_APKS
EOF
  if [ "$n" -gt 0 ] && [ "$good" = "$n" ]; then res=PASS; else res=FAIL; fi
  c="$good of $n prod APK(s) pass; apksigner exit $(printf '%s\n' $srcs | sort -u | tr '\n' '/' | sed 's#/$##'); versionCode $(printf '%s\n' $vcs | sort -u | tr '\n' '/' | sed 's#/$##') (want $EXPECT_VERSION_CODE); application-debuggable $(printf '%s\n' $dbgs | sort -u | tr '\n' '/' | sed 's#/$##')"
  c="$c; signing certificates $(printf '%s\n' $ncs | sort -u | tr '\n' '/' | sed 's#/$##'), CN=$(printf '%s\n' "${cns#|}" | tr '|' '\n' | sort -u | tr '\n' '/' | sed 's#/$##')"
  if [ -z "$fleet" ]; then
    c="$c; certificate SHA-256 $(printf '%s\n' $shas | sort -u | tr '\n' '/' | sed 's#/$##') — FLEET_CERT_SHA256 not found in rel_common.sh"
  elif [ "$(printf '%s\n' $shas | sort -u)" = "$fleet" ]; then
    c="$c; certificate SHA-256 $(printf '%.16s' "$fleet")… = FLEET_CERT_SHA256 (the key that signed APK 19)"
  else
    c="$c; certificate SHA-256 $(printf '%s\n' $shas | sort -u | tr '\n' '/' | sed 's#/$##') — NOT the fleet's $(printf '%.16s' "$fleet")…: every phone would refuse this update, do not publish"
  fi
  echo "# finished: $(date -u +%FT%TZ)" >> "$plog"
  record 6b "android: prod APKs, apksigner + aapt badging" "$res" "-" "$c" "$(rel "$plog")"
}

if wants android; then
  INIT="$OUT/no-firebase-upload.init.gradle"
  cat > "$INIT" <<'GRADLE'
// Written by LOCAL-VERIFY-mac.command. A local verification build must send nothing to Firebase.
// The Crashlytics Gradle plugin uploads the R8 mapping file of a minified build (here: prod) to the
// Firebase project named in google-services.json, so every Crashlytics upload task is disabled (SKIPPED).
allprojects {
    tasks.configureEach { t ->
        if (t.name.startsWith('uploadCrashlytics')) {
            t.enabled = false
        }
    }
}
GRADLE
  if [ -z "$AJ" ]; then
    record 6a "android: unit tests + debug + prod builds" FAIL - "no Java for Gradle: JAVA_HOME unset, no Android Studio JBR, /usr/libexec/java_home found nothing" -
    record 6b "android: prod APKs, apksigner + aapt badging" SKIPPED - "no build (6a)" -
  else
    # Unit-test results left by an EARLIER run must never be counted as this run's (1 Nov: the test sources did not
    # compile, testDebugUnitTest never ran, and 34 XML files from 25 Oct were reported as "310 tests, 0 failures").
    MARK6A="$OUT/.6a-started"; : > "$MARK6A"
    run_step 6a android-gradle "$APP" env "JAVA_HOME=$AJ" "PATH=$AJ/bin:$PATH" ./gradlew --no-daemon --console=plain --continue \
      --init-script "$INIT" :app:testDebugUnitTest :app:assembleDebug :app:assembleProd
    G_RC=$RC; G_LOG=$LOG
    XMLD="$APP/app/build/test-results/testDebugUnitTest"
    TSTATE="$(task_state :app:testDebugUnitTest "$G_LOG")"
    mkdir -p "$OUT/android-unit-xml"
    UT=0; UF=0; UE=0; US=0; UX=0; USTALE=0
    for x in "$XMLD"/TEST-*.xml; do
      [ -f "$x" ] || continue
      case "$TSTATE" in
        UP-TO-DATE|FROM-CACHE) : ;;   # identical inputs: Gradle reused results that belong to this exact source
        *) [ "$x" -nt "$MARK6A" ] || { USTALE=$((USTALE + 1)); continue; } ;;
      esac
      UX=$((UX + 1)); cp "$x" "$OUT/android-unit-xml/"
      h="$(grep -m 1 '<testsuite ' "$x")"
      a="$(printf '%s' "$h" | sed -n 's/.* tests="\([0-9]*\)".*/\1/p')";    UT=$((UT + ${a:-0}))
      a="$(printf '%s' "$h" | sed -n 's/.* failures="\([0-9]*\)".*/\1/p')"; UF=$((UF + ${a:-0}))
      a="$(printf '%s' "$h" | sed -n 's/.* errors="\([0-9]*\)".*/\1/p')";   UE=$((UE + ${a:-0}))
      a="$(printf '%s' "$h" | sed -n 's/.* skipped="\([0-9]*\)".*/\1/p')";  US=$((US + ${a:-0}))
    done
    DEBUG_APKS="$(list_apks "$APP/app/build/outputs/apk/debug")"
    PROD_APKS="$(list_apks "$APP/app/build/outputs/apk/prod")"
    N_DBG="$(printf '%s\n' "$DEBUG_APKS" | grep -c .)"
    N_PROD="$(printf '%s\n' "$PROD_APKS" | grep -c .)"
    UP_SKIPPED="$(count_re '^> Task :app:uploadCrashlytics[A-Za-z]* SKIPPED' "$G_LOG")"
    UP_RAN="$(LC_ALL=C grep -E '^> Task :app:uploadCrashlytics' "$G_LOG" | grep -vc ' SKIPPED$')"
    [ "$UP_RAN" = 0 ] || note "a Crashlytics upload task was NOT reported SKIPPED in 6a — read logs/6a-android-gradle.log"
    PSTATE="$(task_state :app:assembleProd "$G_LOG")"
    R6A="$(pf "$G_RC")"
    case "$TSTATE" in
      executed|UP-TO-DATE|FROM-CACHE) [ "$UT" -gt 0 ] && [ "$UF" = 0 ] && [ "$UE" = 0 ] || R6A=FAIL ;;
      *) R6A=FAIL ;;   # the unit tests did not run: never a PASS, whatever the build did
    esac
    [ "$USTALE" = 0 ] || note "6a ignored $USTALE unit-test XML file(s) older than this run (not this build's results)"
    record 6a "android: unit tests + debug + prod builds" "$R6A" "$G_RC" \
      "unit tests $UT, failures $UF, errors $UE, skipped $US ($UX XML files of this run, $USTALE stale ignored, testDebugUnitTest $TSTATE); assembleDebug $(task_state :app:assembleDebug "$G_LOG") ($N_DBG APKs); assembleProd $PSTATE ($N_PROD APKs); Crashlytics upload tasks SKIPPED: $UP_SKIPPED" \
      "$(rel "$G_LOG")"
    if [ "$PSTATE" = "not run" ] || [ "$PSTATE" = "FAILED" ] || [ "$N_PROD" = 0 ]; then
      record 6b "android: prod APKs, apksigner + aapt badging" SKIPPED - "no current prod APK (assembleProd: $PSTATE)" -
    elif [ -z "$BT" ]; then
      record 6b "android: prod APKs, apksigner + aapt badging" FAIL - "no Android build-tools with apksigner under $SDK/build-tools" -
    elif ! command -v python3 >/dev/null 2>&1; then
      record 6b "android: prod APKs, apksigner + aapt badging" FAIL - "python3 not found on PATH (tools/apk_cert.py reads the signing certificate)" -
    else
      verify_prod_apks
    fi
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────────────────────────────────────────
trap - INT TERM HUP
finish
echo ""
cat "$SUMMARY"
echo ""
echo "Saved: $SUMMARY"
if command -v open >/dev/null 2>&1; then open "$SUMMARY" >/dev/null 2>&1; fi
[ "$FAILS" -eq 0 ] || exit 1
exit 0

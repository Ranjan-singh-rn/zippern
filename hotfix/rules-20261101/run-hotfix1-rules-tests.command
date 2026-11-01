#!/bin/bash
# HOTFIX-1 (2026-11-01) — run the rules suites against hotfix/rules-20261101/
# on the LOCAL emulators. Modelled on tests/run-p1mfa-verify.command.
#
# What it runs (every suite inside `firebase emulators:exec --project demo-zipper`,
# with ZIPPER_RULES_FILE / ZIPPER_STORAGE_RULES_FILE pointing at the hotfix text):
#
#   MUST PASS   hotfix1          tests/firestore.hotfix1.rules.test.mjs   (new)
#               hotfix1:storage  tests/storage.hotfix1.rules.test.mjs     (new)
#               storage          tests/storage.rules.test.mjs
#               firestore        tests/firestore.rules.test.mjs
#               phase1a          tests/firestore.phase1a.rules.test.mjs   (*)
#               ugp, fx, gov, rc tests/firestore.{ugp,fx,gov,rc}.rules.test.mjs
#   INFO ONLY   p1gov            tests/firestore.p1gov.rules.test.mjs     (working-tree P1-D/E hunks: expected failures)
#               p1mfa            tests/firestore.p1mfa.rules.test.mjs     (Owner-MFA candidate: expected failures)
#   SKIPPED     storage.p1mfa / auth.p1mfa — they test the Owner-MFA candidate only
#               (storage.p1mfa hard-codes ../storage.rules; auth.p1mfa needs the auth emulator).
#
#   (*) phase1a has 3 checks that fail on the DEPLOYED lineage by design (first-
#       login gate answers; see phase1a-known-failures.txt). It PASSES here only
#       if every FAIL line it prints is one of those.
#
# Every suite that prints a `rules sha256:` line is checked against the sha256 of
# the file this runner meant to test; a mismatch fails the run.
#
# Safety:
#   * refuses to start if any rules suite names a projectId other than demo-zipper;
#   * a demo- project exists only in the emulator: no login, no real project;
#   * GOOGLE_APPLICATION_CREDENTIALS and FIREBASE_TOKEN are removed from the environment;
#   * no deploy, no git, no network beyond 127.0.0.1 (the CLI may download the
#     emulator JARs on first use — that is the only outbound request).
#
# Output: hotfix/rules-20261101/results-<UTC>/{<suite>.log, SUMMARY.txt, RESULT.txt}
# Exit:   0 = every MUST-PASS suite passed (phase1a within its allowlist)
#         1 = at least one MUST-PASS suite failed or a sha256 mismatch
#         2 = refused to start (preflight)
#
#   SKIP_INFO=1 bash hotfix/rules-20261101/run-hotfix1-rules-tests.command   # skip the INFO suites

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT" || exit 2
unset GOOGLE_APPLICATION_CREDENTIALS
unset FIREBASE_TOKEN

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/results-$STAMP"
while [ -e "$OUT" ]; do sleep 1; STAMP="$(date -u +%Y%m%dT%H%M%SZ)"; OUT="$HERE/results-$STAMP"; done
mkdir -p "$OUT"
SUMMARY="$OUT/SUMMARY.txt"
RESULT="$OUT/RESULT.txt"

FS_RULES="$HERE/firestore.rules"
ST_RULES="$HERE/storage.rules"
export ZIPPER_RULES_FILE="$FS_RULES"
export ZIPPER_STORAGE_RULES_FILE="$ST_RULES"

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

say() { echo "$*" | tee -a "$SUMMARY"; }

# ── Preflight: refuse, never guess ──────────────────────────────────────────
refuse() { say "REFUSING: $*"; echo "REFUSED" > "$RESULT"; exit 2; }

[ -f "$FS_RULES" ] || refuse "$FS_RULES is missing"
[ -f "$ST_RULES" ] || refuse "$ST_RULES is missing"
[ -f "$HERE/phase1a-known-failures.txt" ] || refuse "phase1a-known-failures.txt is missing"
for f in tests/firestore.hotfix1.rules.test.mjs tests/storage.hotfix1.rules.test.mjs \
         tests/storage.rules.test.mjs tests/firestore.rules.test.mjs tests/firestore.phase1a.rules.test.mjs \
         tests/firestore.ugp.rules.test.mjs tests/firestore.fx.rules.test.mjs tests/firestore.gov.rules.test.mjs \
         tests/firestore.rc.rules.test.mjs tests/firestore.p1gov.rules.test.mjs tests/firestore.p1mfa.rules.test.mjs; do
  [ -f "$f" ] || refuse "$f is missing"
done
if grep -rn "projectId: '" tests/*.rules.test.mjs | grep -v "projectId: 'demo-zipper'" ; then
  refuse "a rules test does not pin projectId demo-zipper."
fi
command -v firebase >/dev/null || refuse "firebase CLI not found on PATH (npm i -g firebase-tools)"
command -v java >/dev/null || refuse "java not found (the emulators need a JDK 21)"
command -v node >/dev/null || refuse "node not found"
command -v shasum >/dev/null || refuse "shasum not found"
for pkg in "@firebase/rules-unit-testing" "firebase"; do
  [ -f "tests/node_modules/$pkg/package.json" ] || refuse "tests/node_modules/$pkg is not installed (cd tests && npm ci)"
done

FS_SHA="$(sha256_of "$FS_RULES")"
ST_SHA="$(sha256_of "$ST_RULES")"
{
  echo "HOTFIX-1 rules tests  $STAMP"
  echo "repo:            $ROOT"
  echo "firestore rules: $FS_RULES"
  echo "  sha256:        $FS_SHA"
  echo "storage rules:   $ST_RULES"
  echo "  sha256:        $ST_SHA"
  echo "firebase:        $(firebase --version 2>/dev/null | head -1)"
  echo "node:            $(node --version 2>/dev/null)"
  echo "java:            $(java -version 2>&1 | head -1)"
  echo ""
} | tee "$SUMMARY"

# The two suites that do not print a sha print the path they loaded; make sure
# the override took (a stale copy of the suite would silently test ../firestore.rules).
check_loaded_path() {   # log, label-regex, expected path
  local got
  got="$(grep -E "^$2" "$1" | head -1 | sed -E "s/^$2//")"
  [ "$got" = "$3" ]
}
check_sha() {           # log, label-regex, expected sha  (passes if the suite printed no such line)
  local got
  got="$(grep -E "^$2" "$1" | head -1 | sed -E "s/^$2//" | tr -d '[:space:]')"
  [ -z "$got" ] || [ "$got" = "$3" ]
}

FAILED=0
run() {   # name, emulators, test file, mode (must|info)
  local name="$1" emus="$2" file="$3" mode="$4" log="$OUT/${1//:/-}.log" rc verdict
  say "=== $name ($emus) [$mode] ==="
  firebase emulators:exec --only "$emus" --project demo-zipper "node tests/$file" >"$log" 2>&1
  rc=$?
  verdict="exit=$rc"
  if ! check_sha "$log" "rules sha256: " "$FS_SHA"; then
    verdict="$verdict SHA-MISMATCH(firestore)"; [ "$mode" = must ] && FAILED=1
  fi
  if ! check_sha "$log" "storage rules sha256: " "$ST_SHA"; then
    verdict="$verdict SHA-MISMATCH(storage)"; [ "$mode" = must ] && FAILED=1
  fi
  if grep -q "^rules under test: " "$log" && ! check_loaded_path "$log" "rules under test: " "$FS_RULES"; then
    verdict="$verdict WRONG-FILE(firestore)"; [ "$mode" = must ] && FAILED=1
  fi
  if grep -q "^storage rules under test: " "$log" && ! check_loaded_path "$log" "storage rules under test: " "$ST_RULES"; then
    verdict="$verdict WRONG-FILE(storage)"; [ "$mode" = must ] && FAILED=1
  fi
  if [ "$name" = phase1a ]; then
    # Allowed to fail only on the recorded deployed-lineage checks.
    local unexpected=0 claim
    grep -E '^  FAIL  ' "$log" | sed -E 's/^  FAIL  //' > "$OUT/phase1a.failed-claims.txt"
    while IFS= read -r claim; do
      [ -z "$claim" ] && continue
      if ! grep -Fxq -- "$claim" "$HERE/phase1a-known-failures.txt"; then
        unexpected=1; say "  UNEXPECTED phase1a failure: $claim"
      fi
    done < "$OUT/phase1a.failed-claims.txt"
    if [ $rc -ne 0 ] && [ $unexpected -eq 0 ] && [ -s "$OUT/phase1a.failed-claims.txt" ]; then
      verdict="$verdict KNOWN-FAILURES-ONLY($(wc -l < "$OUT/phase1a.failed-claims.txt" | tr -d ' '))  → PASS"
    elif [ $rc -ne 0 ]; then
      verdict="$verdict → FAIL"; FAILED=1
    else
      verdict="$verdict → PASS"
    fi
  elif [ "$mode" = must ]; then
    if [ $rc -eq 0 ]; then verdict="$verdict → PASS"; else verdict="$verdict → FAIL"; FAILED=1; fi
  else
    verdict="$verdict (info only; expected to fail on the deployed lineage)"
  fi
  grep -E "RESULT|checks passed|checks FAILED" "$log" | sed 's/^/    /' | tee -a "$SUMMARY"
  say "$name $verdict"
}

run hotfix1          firestore         firestore.hotfix1.rules.test.mjs  must
run hotfix1:storage  storage,firestore storage.hotfix1.rules.test.mjs    must
run storage          storage,firestore storage.rules.test.mjs            must
run firestore        firestore         firestore.rules.test.mjs          must
run phase1a          firestore         firestore.phase1a.rules.test.mjs  must
run ugp              firestore         firestore.ugp.rules.test.mjs      must
run fx               firestore         firestore.fx.rules.test.mjs       must
run gov              firestore         firestore.gov.rules.test.mjs      must
run rc               firestore         firestore.rc.rules.test.mjs       must
if [ "${SKIP_INFO:-0}" != "1" ]; then
  run p1gov          firestore         firestore.p1gov.rules.test.mjs    info
  run p1mfa          firestore         firestore.p1mfa.rules.test.mjs    info
else
  say "p1gov / p1mfa skipped (SKIP_INFO=1)"
fi

say ""
say "--- FAIL lines across all logs ---"
grep -H -E "^  FAIL " "$OUT"/*.log | sed "s#$OUT/##" | tee -a "$SUMMARY"
say ""
if [ $FAILED -eq 0 ]; then
  say "HOTFIX1-RUN: PASS (every must-pass suite passed; phase1a within its allowlist)"
  echo "PASS" > "$RESULT"
else
  say "HOTFIX1-RUN: FAIL (see the suite lines above and the logs in $OUT)"
  echo "FAIL" > "$RESULT"
fi
say "Results: $OUT"
exit $FAILED

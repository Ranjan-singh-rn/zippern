#!/bin/bash
# P1-A3b — run every Firestore / Storage rules suite against the LOCAL emulators.
#
# Safety:
#   * refuses to start if any suite command names a project other than demo-zipper;
#   * every suite runs inside `firebase emulators:exec` with --project demo-zipper
#     (a demo- project exists only in the emulator; no login, no real project);
#   * GOOGLE_APPLICATION_CREDENTIALS is removed from the environment;
#   * no deploy, no git, no network beyond 127.0.0.1.
# Output: outputs/verify/p1mfa-rules-<timestamp>.log, plus a summary on screen.

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
mkdir -p outputs/verify
LOG="outputs/verify/p1mfa-rules-$(date +%Y%m%d-%H%M%S).log"
unset GOOGLE_APPLICATION_CREDENTIALS

if grep -E '"test[^"]*": ' tests/package.json | grep -v -- '--project demo-zipper' | grep -q 'emulators:exec'; then
  echo "REFUSING: a suite in tests/package.json does not use --project demo-zipper." | tee -a "$LOG"
  exit 2
fi
if grep -rn "projectId: '" tests/*.rules.test.mjs | grep -v "projectId: 'demo-zipper'" ; then
  echo "REFUSING: a rules test does not pin projectId demo-zipper." | tee -a "$LOG"
  exit 2
fi
command -v firebase >/dev/null || { echo "firebase CLI not found" | tee -a "$LOG"; exit 2; }
command -v java >/dev/null || { echo "java not found (the emulators need it)" | tee -a "$LOG"; exit 2; }

run() {   # name, emulators, test file
  echo "=== $1 ($2) ===" | tee -a "$LOG"
  firebase emulators:exec --only "$2" --project demo-zipper "node tests/$3" >>"$LOG" 2>&1
  local rc=$?
  echo "$1 exit=$rc" | tee -a "$LOG"
  return $rc
}

FAILED=0
run storage            storage,firestore storage.rules.test.mjs            || FAILED=1
run p1mfa:storage      storage,firestore storage.p1mfa.rules.test.mjs      || FAILED=1
run firestore          firestore         firestore.rules.test.mjs          || FAILED=1
run phase1a            firestore         firestore.phase1a.rules.test.mjs  || FAILED=1
run ugp                firestore         firestore.ugp.rules.test.mjs      || FAILED=1
run p1gov              firestore         firestore.p1gov.rules.test.mjs    || FAILED=1
run p1mfa              firestore         firestore.p1mfa.rules.test.mjs    || FAILED=1
run fx                 firestore         firestore.fx.rules.test.mjs       || FAILED=1
run gov                firestore         firestore.gov.rules.test.mjs      || FAILED=1
run rc                 firestore         firestore.rc.rules.test.mjs       || FAILED=1

echo "--- result lines ---" | tee -a "$LOG"
grep -E "RESULT|checks passed|checks FAILED|FAIL |exit=" "$LOG" | tee "$LOG.summary"
echo "Full log: $LOG"
exit $FAILED

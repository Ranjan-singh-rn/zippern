#!/bin/bash
# ZIPPER completion release — 33: deploy the Firestore INDEXES only — the repository's firestore.indexes.json at the
# release HEAD — BEFORE APK 20 and the RC2 rules, whose queries need them (RUNBOOK.md step 2, after 32).
# Production change (after you type INDEXES), exactly:
#   firebase deploy --only firestore:indexes --project zipper-83816 --non-interactive
# from a temp folder holding ONLY firestore.indexes.json and a generated firebase.json
# {"firestore":{"database":"(default)","indexes":"firestore.indexes.json"}} (no rules, no storage, no functions).
# It never deletes an index. Before deploying it reads the LIVE composite indexes and field overrides (read-only gcloud)
# and REFUSES unless the file is a superset of them: every live composite index and every live field override is in
# the file, and no field override of the file drops a single-field index (or a TTL policy) that is live today — for a
# field without a live override, the automatic indexes. The CLI itself only offers to delete what the file lacks; with
# --non-interactive it takes that question's default, No (never --force), and stdin is /dev/null, so no typed answer
# can reach it. After the deploy it polls (read-only, every 60 s, up to 30 min) until every index of the file is READY
# and reports the ones still building, and checks that every index live before is still live. A re-run finds nothing
# to create, asks nothing and only waits. Refuses if: the tree is dirty or not at RELEASE.txt's HEAD;
# firestore.indexes.json is not the RELEASE.txt text. No rollback: indexes are additive (an unused index is harmless;
# nothing in this folder deletes one). 31 deploys the same file again at step 9 (a no-op for the indexes).
# Results: ./production/33-indexes-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 33-indexes
need_tools gcloud firebase python3 git shasum

INDEXES="$REPO/firestore.indexes.json"
say "ZIPPER completion release — 33 Firestore indexes   $TS"
who
require_release
GOT="$(shasum -a 256 "$INDEXES" | cut -c1-64)"
grep -q "^FILE firestore.indexes.json $GOT\$" "$RELEASE_TXT" && check ok "firestore.indexes.json = RELEASE.txt ($GOT)" || stop "firestore.indexes.json is not the recorded release text"

# live_indexes <prefix>: the live composite indexes and field overrides (index definitions and states only).
live_indexes() {
  gcloud firestore indexes composite list --project "$P" --format=json > "$1-composite.json" 2>>"$ERR" || stop "could not list the live composite indexes (stderr.log)"  #RO
  gcloud firestore indexes fields list --project "$P" --format=json > "$1-fields.json" 2>>"$ERR" || stop "could not list the live field overrides (stderr.log)"  #RO
}

say ""; say "== 1. The file against the live indexes (read-only)"
live_indexes "$OUT/live-before"
$H indexes-check "$INDEXES" "$OUT/live-before-composite.json" "$OUT/live-before-fields.json" > "$OUT/indexes-check.txt"
sed 's/^/   /' "$OUT/indexes-check.txt" | tee -a "$OUT/SUMMARY.txt"
grep -q '^SUPERSET ok$' "$OUT/indexes-check.txt" || stop "firestore.indexes.json is not a superset of the live indexes (LIVE-NOT-IN-FILE / WOULD-REMOVE above): a deploy could delete an index. Nothing was deployed."
check ok "firestore.indexes.json is a superset of the live indexes (nothing would be deleted)"

if grep -q '^CHANGES 0 ' "$OUT/indexes-check.txt"; then
  say "every index and field override of the file is already live — nothing to deploy; waiting for READY only"
else
  rules_workdir '{"firestore":{"database":"(default)","indexes":"firestore.indexes.json"}}' "$INDEXES"
  confirm INDEXES "deploy firestore.indexes.json ($GOT) to $P: $(sed -n 's/^CHANGES [0-9]* (\(.*\))$/\1/p' "$OUT/indexes-check.txt") (listed above); nothing is deleted"
  ( cd "$WS" && firebase deploy --only firestore:indexes --project zipper-83816 --non-interactive < /dev/null ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-INDEXES
  rc=$?
  tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
  [ $rc -eq 0 ] && grep -qi 'deploy complete' "$OUT/firebase-deploy.log" && check ok "firebase deploy: firestore indexes" || check "exit $rc" "firebase deploy: firestore indexes"
fi

say ""; say "== 2. Build state (read-only, every 60 s, up to 30 min)"
READY=no; i=1
while :; do
  live_indexes "$OUT/live-now"
  $H indexes-ready "$INDEXES" "$OUT/live-now-composite.json" "$OUT/live-now-fields.json" "$OUT/live-before-composite.json" "$OUT/live-before-fields.json" > "$OUT/indexes-ready.txt"
  if grep -q '^INDEXES-READY yes$' "$OUT/indexes-ready.txt"; then READY=yes; break; fi
  say "   check $i/31: $(sed -n 's/^READY-COUNT //p' "$OUT/indexes-ready.txt") READY, $(grep -c '^BUILDING ' "$OUT/indexes-ready.txt") still building"
  [ "$i" -ge 31 ] && break
  i=$((i + 1)); sleep 60
done
grep -E '^(GONE|BUILDING) ' "$OUT/indexes-ready.txt" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt"
grep -q '^KEPT-ALL yes$' "$OUT/indexes-ready.txt" && check ok "every index that was live before is still live (nothing deleted)" || check "see GONE lines" "every index that was live before is still live"
if [ "$READY" = yes ]; then
  check ok "every index of firestore.indexes.json is READY ($(sed -n 's/^READY-COUNT //p' "$OUT/indexes-ready.txt"))"
else
  check "$(grep -c '^BUILDING ' "$OUT/indexes-ready.txt") still building after 30 min (listed above)" "every index of firestore.indexes.json READY"
fi
finish "re-run 33 later: it deploys nothing new and only waits for READY. Do not publish APK 20 or release RC2 before READY"

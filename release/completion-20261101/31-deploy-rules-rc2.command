#!/bin/bash
# ZIPPER completion release — 31: release the RC2 Firestore rules AND indexes — the repository's firestore.rules and
# firestore.indexes.json at the release HEAD (the Owner-MFA candidate consolidated with hotfix-1 and the P1 hunks).
# Usage: 31-deploy-rules-rc2.command <results-dir>   (the emulator results folder of the RC2 rules run on the Mac)
# Production change (after you type RELEASE), exactly:
#   firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive
# from a temp folder holding ONLY those two files and a generated firebase.json. Indexes: missing composite indexes
# are created; indexes that exist in Firestore but not in the file are NOT deleted (--non-interactive without
# --force only reports them). Never --force.
# COORDINATION (RUNBOOK.md step 9): these rules read an Owner's role as superadmin_mfa_pending unless the Firebase session
# is bound to an MFA-verified API session. Release them ONLY when the completion backend serves 100% (11+12) and the
# MFA CRM is live (50) — both checked here — and within minutes of each other. Refuses if: the tree is dirty or not
# at RELEASE.txt's HEAD; the results folder is missing, not PASS, older than the files, or names another hash.
# Before releasing it SAVES the live ruleset text — 39-rollback-rules.command re-releases it (together with the CRM
# rollback to Hosting ba740f4158292308, RUNBOOK.md steps 6 and 9). Results: ./production/31-rules-rc2-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 31-rules-rc2
need_tools gcloud firebase python3 git shasum

RULES="$REPO/firestore.rules"; INDEXES="$REPO/firestore.indexes.json"
RESULTS="${1:-}"
say "ZIPPER completion release — 31 Firestore rules + indexes RC2   $TS"
who
require_release
[ -n "$RESULTS" ] || stop "usage: $0 <results-dir> — the emulator results folder of the RC2 rules run (RESULT.txt = PASS)"
GOT="$(shasum -a 256 "$RULES" | cut -c1-64)"
grep -q "^FILE firestore.rules $GOT\$" "$RELEASE_TXT" && check ok "firestore.rules = RELEASE.txt ($GOT)" || stop "firestore.rules is not the recorded release text"
grep -q "^FILE firestore.indexes.json $(shasum -a 256 "$INDEXES" | cut -c1-64)\$" "$RELEASE_TXT" && check ok "firestore.indexes.json = RELEASE.txt" || stop "firestore.indexes.json is not the recorded release text"
python3 -I -c 'import json,sys; j=json.load(open(sys.argv[1])); print("INDEXES %d fieldOverrides %d" % (len(j.get("indexes",[])), len(j.get("fieldOverrides",[]))))' "$INDEXES" | sed 's/^/   /' | tee -a "$OUT/SUMMARY.txt" || stop "firestore.indexes.json is not valid JSON"
rules_evidence "$RESULTS" "$RULES"
require_backend_serving_new
require_crm_live
save_live_rules firestore "$OUT/live-firestore-before"
[ "$LIVE_SHA" = "$GOT" ] && say "the RC2 rules text is already live (indexes will still be deployed)"
rules_workdir '{"firestore":{"database":"(default)","rules":"firestore.rules","indexes":"firestore.indexes.json"}}' "$RULES" "$INDEXES"

confirm RELEASE "release firestore.rules ($GOT) and firestore.indexes.json as the Firestore rules/indexes of $P (replacing the live ruleset $LIVE_SHA, saved for 39)"
( cd "$WS" && firebase deploy --only firestore:rules,firestore:indexes --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-RULES-RC2
rc=$?
tail -20 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
grep -qi 'not present in your' "$OUT/firebase-deploy.log" && say "   note: Firestore holds indexes that are not in firestore.indexes.json; they were NOT deleted (never --force)"
verify_live_rules firestore "$RULES"
finish "if Owners are locked out: 39-rollback-rules.command $OUT AND the CRM rollback (RUNBOOK.md steps 6 and 9)"

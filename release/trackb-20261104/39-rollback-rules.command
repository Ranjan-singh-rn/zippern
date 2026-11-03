#!/bin/bash
# ZIPPER Track B release — 39: ROLLBACK of the Firestore rules: re-release the live text that 31 SAVED before it
# changed anything (hotfix-1, live since 1 Nov). Usage: 39-rollback-rules.command <evidence-folder-of-31>
# Production change (after you type ROLLBACK), exactly:
#   firebase deploy --only firestore:rules --project zipper-83816 --non-interactive
# from a temp folder holding ONLY the saved text (checked against its recorded sha256) and a generated firebase.json.
# Indexes are never rolled back (additive, harmless). After a 31 rollback consider the CRM rollback to Hosting
# bf4066501e5f593a (console; RUNBOOK.md); APK 21's PK battles keep working (server-written), its leaderboard, Party Pro
# status and music reads are refused again under the old rules.
# Results: ./production/39-rollback-rules-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 39-rollback-rules
need_tools gcloud firebase python3 git shasum

SRC_DIR="${1:-}"
say "ZIPPER Track B release — 39 Firestore rules ROLLBACK   $TS"
who
require_release
[ -n "$SRC_DIR" ] && [ -d "$SRC_DIR" ] || stop "usage: $0 <evidence folder of 31 holding live-firestore-before.rules>"
case "$(basename "$SRC_DIR")" in 31-rules-rc2-*Z) ;; *) stop "$(basename "$SRC_DIR") is not an evidence folder of 31 (31-rules-rc2-<UTC>)";; esac
SAVED="$SRC_DIR/live-firestore-before.rules"
[ -f "$SAVED" ] && [ -f "$SAVED.sha256" ] || stop "$SAVED (and .sha256) not found"
WANT="$(awk '{print $1}' "$SAVED.sha256")"; GOT="$(shasum -a 256 "$SAVED" | cut -c1-64)"
[ "$WANT" = "$GOT" ] && check ok "saved text matches its recorded sha256 ($GOT)" || stop "the saved text does not match its recorded sha256"
say "   saved from: $(sed -n 's/^LIVE-RULESET /ruleset /p' "$SRC_DIR/live-firestore-before.txt" 2>/dev/null) updated $(sed -n 's/^LIVE-UPDATED //p' "$SRC_DIR/live-firestore-before.txt" 2>/dev/null)"
save_live_rules firestore "$OUT/live-firestore-before"
[ "$LIVE_SHA" = "$GOT" ] && { say "the saved text is already live — nothing to do"; finish; }
rules_workdir '{"firestore":{"database":"(default)","rules":"firestore.rules"}}' "$SAVED"
mv "$WS/live-firestore-before.rules" "$WS/firestore.rules"
CRM_NOTE=""; [ -f "$STATE_CRM" ] && CRM_NOTE=" — the new CRM is live: roll it back to Hosting $OLD_CRM_VERSION in the console at the same time"
confirm ROLLBACK "re-release the saved Firestore rules text ($GOT) over the live ruleset $LIVE_SHA$CRM_NOTE"
( cd "$WS" && firebase deploy --only firestore:rules --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-RULES-ROLLBACK
rc=$?
tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
verify_live_rules firestore "$WS/firestore.rules"
finish

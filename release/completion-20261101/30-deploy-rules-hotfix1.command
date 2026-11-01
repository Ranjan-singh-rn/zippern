#!/bin/bash
# ZIPPER completion release — 30: release the HOTFIX-1 Firestore rules (hotfix/rules-20261101/firestore.rules: the
# DEPLOYED 20 Oct text plus the reviewed hotfix hunks — techTickets staff-only, coinPurchaseRequests scoped,
# appConfig/androidUpdate and calls/callHistory client writes refused, empty-contact profile setup for pre-19 builds).
# Usage: 30-deploy-rules-hotfix1.command [results-dir]   (default: the newest hotfix/rules-20261101/results-<UTC>/)
# Production change (after you type RELEASE), exactly:
#   firebase deploy --only firestore:rules --project zipper-83816 --non-interactive
# from a temp folder holding ONLY that rules file and a generated firebase.json (no indexes, no storage, no functions).
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; the hotfix file's sha256 differs from the bundle's
# SHA256SUMS; the emulator results folder is missing, not PASS, older than the rules file, or names another hash.
# Before releasing it SAVES the live ruleset text (read-only fetch) — 39-rollback-rules.command re-releases it.
# No client dependency: APK 19 and 20 both work under these rules (the bundle's A-1 hunk exists for pre-19 builds).
# Results: ./production/30-rules-hotfix1-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 30-rules-hotfix1
need_tools gcloud firebase python3 git shasum

BUNDLE="$REPO/hotfix/rules-20261101"
RULES="$BUNDLE/firestore.rules"
RESULTS="${1:-$(newest_results "$BUNDLE")}"
say "ZIPPER completion release — 30 Firestore rules HOTFIX-1   $TS"
who
require_release
[ -f "$RULES" ] || stop "$RULES not found"
WANT="$(grep ' firestore.rules$' "$BUNDLE/SHA256SUMS" | awk '{print $1}')"
GOT="$(shasum -a 256 "$RULES" | cut -c1-64)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] && check ok "hotfix firestore.rules = bundle SHA256SUMS ($GOT)" || stop "hotfix/rules-20261101/firestore.rules does not match its SHA256SUMS"
rules_evidence "$RESULTS" "$RULES"
save_live_rules firestore "$OUT/live-firestore-before"
[ "$LIVE_SHA" = "$GOT" ] && { say "the hotfix text is already live — nothing to release"; finish; }
rules_workdir '{"firestore":{"database":"(default)","rules":"firestore.rules"}}' "$RULES"

confirm RELEASE "release hotfix/rules-20261101/firestore.rules ($GOT) as the Firestore rules of $P (replacing the live ruleset $LIVE_SHA, saved for 39)"
( cd "$WS" && firebase deploy --only firestore:rules --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-RULES-HOTFIX1
rc=$?
tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
verify_live_rules firestore "$RULES"
finish "if the live text is wrong: 39-rollback-rules.command $OUT"

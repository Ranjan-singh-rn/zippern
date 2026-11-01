#!/bin/bash
# ZIPPER completion release — 32: release the HOTFIX-1 Storage rules (hotfix/rules-20261101/storage.rules: the DEPLOYED
# 20 Oct Storage text plus hunk A-1 only — the profileMedia image cap 5 → 15 MB). P0: profile-photo uploads at sign-up
# fail today (APK 19 uploads the uncompressed gallery photo). The text makes no cross-service Firestore read, so it
# needs no IAM change (40 belongs to the RC2 text of step 9).
# Usage: 32-deploy-storage-hotfix1.command [results-dir]   (default: the newest hotfix/rules-20261101/results-<UTC>/)
# Production change (after you type RELEASE), exactly:
#   firebase deploy --only storage --project zipper-83816 --non-interactive
# from a temp folder holding ONLY storage.rules and a generated firebase.json {"storage":{"rules":"storage.rules"}}
# (single-object form = the project's default bucket zipper-83816.firebasestorage.app; nothing else can deploy).
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; the hotfix file's sha256 differs from the bundle's
# SHA256SUMS; the emulator results folder is missing, not PASS, older than the rules file, or its SUMMARY.txt does not
# name this file's sha256 as the storage text tested. run-hotfix1-rules-tests.command writes that in its SUMMARY.txt
# header ("storage rules:   <path>" then "  sha256:        <sha256>") and writes RESULT.txt = PASS only when every
# must-pass suite passed (hotfix1:storage and storage included), so no fallback to the suite lines is needed.
# Before releasing it SAVES the live Storage ruleset text (read-only fetch) as live-storage-before.rules (+ .sha256),
# exactly as 41 does — 49-rollback-storage.command <this evidence folder> re-releases it.
# Run it right after 30 (RUNBOOK.md step 2). At step 9, 41 replaces this text with the RC2 storage.rules (which keeps
# A-1); 49 on 41's evidence comes back to this text. Results: ./production/32-storage-hotfix1-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 32-storage-hotfix1
need_tools gcloud firebase python3 git shasum

DEPLOYED_20OCT="9899c24aed8699abe153b16da72db0695571fdff4713adee03463643c56b112a"
BUNDLE="$REPO/hotfix/rules-20261101"
RULES="$BUNDLE/storage.rules"
RESULTS="${1:-$(newest_results "$BUNDLE")}"
say "ZIPPER completion release — 32 Storage rules HOTFIX-1   $TS"
who
require_release
[ -f "$RULES" ] || stop "$RULES not found"
WANT="$(grep ' storage.rules$' "$BUNDLE/SHA256SUMS" | awk '{print $1}')"
GOT="$(shasum -a 256 "$RULES" | cut -c1-64)"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] && check ok "hotfix storage.rules = bundle SHA256SUMS ($GOT)" || stop "hotfix/rules-20261101/storage.rules does not match its SHA256SUMS"
rules_evidence "$RESULTS" "$RULES"
TESTED="$(awk '/^storage rules:/ { getline; if ($1 == "sha256:") print $2; exit }' "$RESULTS/SUMMARY.txt" 2>/dev/null)"
[ "$TESTED" = "$GOT" ] && check ok "$(basename "$RESULTS")/SUMMARY.txt: the storage text tested = $GOT" \
  || stop "$(basename "$RESULTS")/SUMMARY.txt does not name $GOT as the storage text tested (${TESTED:-no storage sha256 line}) — re-run run-hotfix1-rules-tests.command"
save_live_rules storage "$OUT/live-storage-before"
[ "$LIVE_SHA" = "$GOT" ] && { say "the hotfix text is already live — nothing to release"; finish; }
[ "$LIVE_SHA" = "$DEPLOYED_20OCT" ] && say "   live text = the 20 Oct DEPLOYED Storage rules (the hotfix is this text + A-1)" \
  || say "   NOTE: the live text is NOT the 20 Oct DEPLOYED Storage rules ($DEPLOYED_20OCT) — releasing replaces it whole (saved for 49)"
rules_workdir '{"storage":{"rules":"storage.rules"}}' "$RULES"

confirm RELEASE "release hotfix/rules-20261101/storage.rules ($GOT) as the Storage rules of the default bucket $BUCKET (replacing the live ruleset $LIVE_SHA, saved for 49)"
( cd "$WS" && firebase deploy --only storage --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-STORAGE-HOTFIX1
rc=$?
tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
verify_live_rules storage "$RULES"
say "   next: one sign-up on APK 19 with a 5-15 MB gallery photo completes its profile photo (RUNBOOK.md step 2)"
finish "if the live text is wrong: 49-rollback-storage.command $OUT"

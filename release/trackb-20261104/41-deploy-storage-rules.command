#!/bin/bash
# ZIPPER Track B release — 41: release the RC2 Storage rules — the repository's storage.rules at the release HEAD
# (unchanged since cf64145; never released by the completion release: the Owner-MFA gate — an `owner` claim counts
# only when a cross-service read of Firestore ownerMfaSessions/{uid} finds a live binding; plus hotfix-1 A-1, the
# 15 MB profile-image cap).
# Usage: 41-deploy-storage-rules.command [results-dir]   (default: the newest rules-results/results-<UTC>/ of
#        tools/run-trackb-rules-tests.command)
# Production change (after you type RELEASE), exactly:
#   firebase deploy --only storage --project zipper-83816 --non-interactive
# from a temp folder holding ONLY storage.rules and a generated firebase.json {"storage":{"rules":"storage.rules"}}
# (single-object form = the project's default bucket zipper-83816.firebasestorage.app; nothing else can deploy).
# Refuses if: the tree is dirty or not at RELEASE.txt's HEAD; storage.rules is not the RELEASE.txt text; the Storage
# service agent does not hold roles/firebaserules.firestoreServiceAgent NOW (40; read live, because without it every
# Owner Storage request fails closed); the RC2 emulator results folder is missing, not PASS, older than storage.rules,
# or names another hash; the backend of this release does not serve 100%; its CRM (50) is not live.
# Before releasing it SAVES the live Storage ruleset text — 49-rollback-storage.command re-releases it.
# Release it with 31 and 40 within minutes (RUNBOOK.md). Results: ./production/41-storage-rules-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
. "$HERE/rel_rules_lib.sh"
verify_scripts
new_out 41-storage-rules
need_tools gcloud firebase python3 git shasum

RULES="$REPO/storage.rules"
RESULTS="${1:-$(ls -d "$HERE/rules-results"/results-*Z 2>/dev/null | LC_ALL=C sort | tail -1)}"
say "ZIPPER Track B release — 41 Storage rules RC2   $TS"
who
require_release
GOT="$(shasum -a 256 "$RULES" | cut -c1-64)"
grep -q "^FILE storage.rules $GOT\$" "$RELEASE_TXT" && check ok "storage.rules = RELEASE.txt ($GOT)" || stop "storage.rules is not the recorded release text"
rules_evidence "$RESULTS" "$RULES"

gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H project-sa-roles - "$STORAGE_AGENT" > "$OUT/agent-roles.txt"  #RO
sed 's/^/   /' "$OUT/agent-roles.txt" | tee -a "$OUT/SUMMARY.txt"
grep "^PROJECT-ROLES $STORAGE_AGENT " "$OUT/agent-roles.txt" | grep -q "$STORAGE_ROLE" \
  && check ok "Storage service agent holds $STORAGE_ROLE (40)" || stop "the Storage service agent lacks $STORAGE_ROLE — run 40-storage-iam-grant.command first (without it every Owner Storage request is denied)"
LAST40="$(ls -d "$HERE/production/40-storage-iam-"*Z 2>/dev/null | LC_ALL=C sort | tail -1)"
say "   40 evidence: ${LAST40:+$(basename "$LAST40")}${LAST40:-none here (role granted elsewhere — the live policy above is what counts)}"
gcloud storage buckets describe "gs://$BUCKET" --format='value(name)' > /dev/null 2>>"$ERR" \
  && check ok "bucket $BUCKET readable" || stop "bucket $BUCKET not readable"  #RO
require_backend_serving_new
require_crm_live

save_live_rules storage "$OUT/live-storage-before"
[ "$LIVE_SHA" = "$GOT" ] && { say "the RC2 Storage rules text is already live — nothing to release"; finish; }
rules_workdir '{"storage":{"rules":"storage.rules"}}' "$RULES"

confirm RELEASE "release storage.rules ($GOT) as the Storage rules of the default bucket $BUCKET (replacing the live ruleset $LIVE_SHA, saved for 49)"
( cd "$WS" && firebase deploy --only storage --project zipper-83816 --non-interactive ) > "$OUT/firebase-deploy.log" 2>&1  #MUT-STORAGE-RC2
rc=$?
tail -15 "$OUT/firebase-deploy.log" | sed 's/^/   | /' | tee -a "$OUT/SUMMARY.txt"
[ $rc -eq 0 ] && grep -qi 'released rules' "$OUT/firebase-deploy.log" && check ok "firebase deploy: released rules" || check "exit $rc" "firebase deploy: released rules"
verify_live_rules storage "$RULES"
say "   next: an Owner with a bound MFA session uploads/reads one CRM image; an Owner WITHOUT one is refused (RUNBOOK.md step 7)"
finish "if Owner Storage access is wrong: 49-rollback-storage.command $OUT"

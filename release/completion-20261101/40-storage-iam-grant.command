#!/bin/bash
# ZIPPER completion release — 40: grant the Storage service agent the role the RC2 Storage rules need to read
# Firestore (ownerMfaSessions). Production change (after you type GRANT), exactly one project IAM binding:
#   gcloud projects add-iam-policy-binding zipper-83816
#     --member=serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com
#     --role=roles/firebaserules.firestoreServiceAgent --condition=None
# Nothing else changes; the live Storage rules make no cross-service call, so this alone changes no behaviour.
# Preconditions: the role is not present yet (checked read-only; if present, nothing is done). The command's output
# (the whole project policy, with people's addresses) is discarded, never written. Rollback: the exact
# remove-iam-policy-binding in APPROVAL-COMMANDS.txt (STORAGE-IAM-REVERT, a separate approval).
# Results: ./production/40-storage-iam-<UTC>/
set -u
umask 077
. "$(dirname "$0")/rel_common.sh"
verify_scripts
new_out 40-storage-iam
need_tools gcloud python3 git

say "ZIPPER completion release — 40 Storage service agent IAM   $TS"
who
require_release
roles() { gcloud projects get-iam-policy "$P" --format=json 2>>"$ERR" | $H project-sa-roles - "$STORAGE_AGENT" | sed 's/^PROJECT-ROLES [^ ]* //'; }  #RO
BEFORE="$(roles)"; say "   agent roles before: ${BEFORE:-none}"
if printf '%s' "$BEFORE" | grep -q "$STORAGE_ROLE"; then
  say "the role is already present; nothing to do"; finish
fi
confirm GRANT "add $STORAGE_ROLE to serviceAccount:$STORAGE_AGENT on project $P (project-level binding, this role only)"
gcloud projects add-iam-policy-binding zipper-83816 --member=serviceAccount:service-239458555881@gcp-sa-firebasestorage.iam.gserviceaccount.com --role=roles/firebaserules.firestoreServiceAgent --condition=None --format=none > /dev/null 2>"$OUT/grant-stderr.txt"  #MUT-STORAGE-IAM
say "grant exit code: $?"
AFTER="$(roles)"; say "   agent roles after: ${AFTER:-none}"
printf '%s' "$AFTER" | grep -q "$STORAGE_ROLE" && check ok "GRANTED — 41-deploy-storage-rules.command may now be approved" || check "not found" "role granted"
finish
